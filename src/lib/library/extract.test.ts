import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter } from "../../../scripts/indexer/exec";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import { extractPages, inspectPdf, type LibraryExtractOptions } from "./extract";
import { SourceFileError } from "./sources/types";
import { encryptedPdf, PERMISSIONS } from "./testing/encryptedPdf";
import { makePdf } from "./testing/helpers";

// Records every external tool call while still running the real tool.
const calls: string[][] = [];
vi.mock("../../../scripts/indexer/exec", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../scripts/indexer/exec")>();
  return {
    ...real,
    runText: (command: string, args: string[], options: { timeoutMs: number }) => {
      calls.push([command, ...args]);
      return real.runText(command, args, options);
    },
  };
});

const skipOcr = process.env.SKIP_OCR_TESTS === "1";

let dir: string;
let cache: OcrCache;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-extract-"));
  cache = new OcrCache(path.join(dir, "ocr.db"));
  calls.length = 0;
});

afterEach(() => {
  cache.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<LibraryExtractOptions> = {}): LibraryExtractOptions {
  const tempDir = path.join(dir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  return {
    ocrPages: "auto",
    ocrLang: "eng",
    ocrDpi: 150,
    pageTimeoutMs: 60_000,
    pageWindow: 5,
    labelsMaxBytes: 20 * 1024 * 1024,
    deadline: Date.now() + 120_000,
    limit: createLimiter(4),
    ocrCache: cache,
    tempDir,
    signal: new AbortController().signal,
    stats: { ocrRun: 0, ocrCached: 0 },
    ...overrides,
  };
}

describe.skipIf(skipOcr)("inspectPdf: encryption", () => {
  it("indexes a PDF that opens without a password but restricts printing/copying/editing", async () => {
    const file = path.join(dir, "restricted.pdf");
    fs.writeFileSync(file, encryptedPdf({ text: "restricted ocelot clause", userPassword: "", ownerPassword: "owner", permissions: PERMISSIONS.none }));
    const info = await inspectPdf(file, 30_000);
    expect(info).toMatchObject({ pageCount: 1, encryption: "restricted" });
    const pages = [];
    for await (const p of extractPages(file, "sha-r", fs.statSync(file).size, info, options())) pages.push(p);
    expect(pages.map((p) => [p.layerText.trim(), p.source])).toEqual([["restricted ocelot clause", expect.any(String)]]);
  });

  it("skips (with kind 'encrypted') a PDF that needs a password to open", async () => {
    const file = path.join(dir, "password.pdf");
    fs.writeFileSync(file, encryptedPdf({ text: "secret", userPassword: "secret", ownerPassword: "owner", permissions: PERMISSIONS.all }));
    const err = await inspectPdf(file, 30_000).catch((e) => e);
    expect(err).toBeInstanceOf(SourceFileError);
    expect(err).toMatchObject({ kind: "encrypted", message: "skipped: encrypted, needs a password to open" });
  });

  it("an unencrypted PDF reports encryption 'none'; a broken one is 'corrupt'", async () => {
    const file = path.join(dir, "plain.pdf");
    await makePdf(file, [{ lines: ["hello"] }], dir);
    expect((await inspectPdf(file, 30_000)).encryption).toBe("none");
    const broken = path.join(dir, "broken.pdf");
    fs.writeFileSync(broken, "%PDF-1.4\nnot a pdf body\n");
    await expect(inspectPdf(broken, 30_000)).rejects.toMatchObject({ kind: "corrupt" });
  });
});

describe.skipIf(skipOcr)("extractPages: page by page", () => {
  it("reads the text layer in windows of pageWindow pages, never with one whole-file pdftotext call", async () => {
    const file = path.join(dir, "twelve.pdf");
    await makePdf(
      file,
      Array.from({ length: 12 }, (_, i) => ({ lines: [`This is page number ${i + 1} with a long enough line of text.`] })),
      dir
    );
    const info = await inspectPdf(file, 30_000);
    const seen: number[] = [];
    for await (const p of extractPages(file, "sha-12", fs.statSync(file).size, info, options({ pageWindow: 5 }))) {
      seen.push(p.pageNo);
      expect(p.layerText).toContain(`page number ${p.pageNo} `);
    }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const pdftotext = calls.filter((c) => c[0] === "pdftotext").map((c) => c.slice(1).join(" "));
    expect(pdftotext).toEqual([
      `-enc UTF-8 -f 1 -l 5 ${file} -`,
      `-enc UTF-8 -f 6 -l 10 ${file} -`,
      `-enc UTF-8 -f 11 -l 12 ${file} -`,
    ]);
  });

  it("only reads printed page labels (pdf.js loads the whole file) for files under labelsMaxBytes", async () => {
    const file = path.join(dir, "labels.pdf");
    const { writeFixturePdf } = await import("../../../scripts/indexer/fixtures");
    await writeFixturePdf(file, [{ lines: ["one"] }, { lines: ["two"] }, { lines: ["three"] }], { labels: true, workDir: dir });
    const info = await inspectPdf(file, 30_000);
    const size = fs.statSync(file).size;
    const withLabels = [];
    for await (const p of extractPages(file, "sha-l", size, info, options())) withLabels.push(p.pageLabel);
    expect(withLabels).toEqual(["i", "ii", "A-1"]);
    const without = [];
    for await (const p of extractPages(file, "sha-l", size, info, options({ labelsMaxBytes: size - 1 }))) without.push(p.pageLabel);
    expect(without).toEqual([null, null, null]);
  });

  it("OCRs only flagged pages by default (LIBRARY_OCR_PAGES=auto), and every non-blank page with 'all'", async () => {
    const file = path.join(dir, "mixed.pdf");
    await makePdf(file, [{ lines: ["A text page with plenty of real characters in its text layer."] }, { imageWords: "SCANNED" }], dir);
    const info = await inspectPdf(file, 30_000);
    const size = fs.statSync(file).size;
    const auto = [];
    for await (const p of extractPages(file, "sha-m", size, info, options())) auto.push(p.source);
    expect(auto).toEqual(["text", "ocr"]);
    const all = [];
    for await (const p of extractPages(file, "sha-m2", size, info, options({ ocrPages: "all" }))) all.push(p.source);
    expect(all).toEqual(["text+ocr", "ocr"]);
  });

  it("deletes each rendered page as soon as it's OCR'd: the temp folder is empty afterwards", async () => {
    const file = path.join(dir, "scan.pdf");
    await makePdf(file, [{ imageWords: "ONE" }, { imageWords: "TWO" }], dir);
    const info = await inspectPdf(file, 30_000);
    const o = options();
    for await (const p of extractPages(file, "sha-s", fs.statSync(file).size, info, o)) void p;
    expect(o.stats.ocrRun).toBe(2);
    expect(fs.readdirSync(o.tempDir)).toEqual([]);
  });

  it("gives up with kind 'timeout' past the per-file deadline", async () => {
    const file = path.join(dir, "slow.pdf");
    await makePdf(file, [{ lines: ["x".repeat(40)] }, { lines: ["y".repeat(40)] }], dir);
    const info = await inspectPdf(file, 30_000);
    const run = async () => {
      for await (const p of extractPages(file, "sha-t", 1, info, options({ deadline: Date.now() - 1 }))) void p;
    };
    await expect(run()).rejects.toMatchObject({ kind: "timeout" });
  });
});
