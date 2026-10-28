import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLimiter } from "../../../scripts/indexer/exec";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import { extractPages, inspectPdf, type LibraryExtractOptions } from "./extract";
import { makePdf } from "./testing/helpers";

/**
 * "smart" OCR in the library (the default once a storage server is connected): a page whose text layer is broken -- here, every
 * letter of every word separate, so a phrase search could never match it -- is OCR'd as well, where "auto" trusts the layer.
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";
let dir: string;
let cache: OcrCache;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-extract-smart-"));
  cache = new OcrCache(path.join(dir, "ocr.db"));
});
afterEach(() => {
  cache.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<LibraryExtractOptions> = {}): LibraryExtractOptions {
  const tempDir = path.join(dir, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  return { ocrPages: "smart", ocrLang: "eng", ocrDpi: 150, pageTimeoutMs: 60_000, pageWindow: 5, labelsMaxBytes: 20 * 1024 * 1024, deadline: Date.now() + 120_000, limit: createLimiter(4), ocrCache: cache, tempDir, signal: new AbortController().signal, stats: { ocrRun: 0, ocrCached: 0 }, ...overrides };
}

const BROKEN = "TENDER NOTICE FOR BHARAT HEAVY ELECTRICALS LIMITED AT TIRUCHIRAPPALLI AND ITS SISTER UNITS";

/** Every letter placed on its own with air around it, as some PDF producers do: pdftotext reads each letter as a word of its own. */
async function brokenPdf(file: string, text: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let x = 30;
  let y = 780;
  for (const ch of text) {
    if (ch === " ") {
      x += 12;
      continue;
    }
    if (x > 560) {
      x = 30;
      y -= 20;
    }
    page.drawText(ch, { x, y, size: 12, font });
    x += 17;
  }
  fs.writeFileSync(file, await doc.save());
}
const CLEAN = "This page is ordinary typed text, long enough to count as a real text layer, with no broken words at all.";

async function read(file: string, o: LibraryExtractOptions): Promise<ExtractedPage[]> {
  const info = await inspectPdf(file, 30_000);
  const pages: ExtractedPage[] = [];
  for await (const p of extractPages(file, "sha", fs.statSync(file).size, info, o)) pages.push(p);
  return pages;
}

describe.skipIf(skipOcr)("library smart OCR", { timeout: 120_000 }, () => {
  it("reads a page with letter-spaced words too, and leaves clean typed pages alone", async () => {
    const file = path.join(dir, "a.pdf");
    await brokenPdf(file, BROKEN);
    const pages = await read(file, options());
    expect(pages.map((p) => [p.pageNo, p.source, p.ocrReason])).toEqual([[1, "text+ocr", expect.stringMatching(/letter-spaced-text|text-outside-layer/)]]);
    expect(pages[0].ocrText ?? "").toMatch(/BHARAT|HEAVY|ELECTRICALS/i);
    // ...and the same file with clean typed pages around it leaves those alone.
    const clean = path.join(dir, "clean.pdf");
    await makePdf(clean, [{ lines: [CLEAN] }, { lines: [CLEAN] }], dir);
    expect((await read(clean, options())).map((p) => [p.source, p.ocrReason])).toEqual([["text", null], ["text", null]]);
  });

  it("'auto' trusts that same broken layer (the gap smart closes)", async () => {
    const file = path.join(dir, "a.pdf");
    await brokenPdf(file, BROKEN);
    const pages = await read(file, options({ ocrPages: "auto" }));
    expect(pages.map((p) => [p.source, p.ocrReason])).toEqual([["text", null]]);
  });

  it("a file over the size the word-position check can read falls back to the 'auto' rules instead of failing", async () => {
    const file = path.join(dir, "a.pdf");
    await brokenPdf(file, BROKEN);
    const pages = await read(file, options({ labelsMaxBytes: 10 }));
    expect(pages.map((p) => p.source)).toEqual(["text"]);
  });

  it("a scanned page and a blank-layer page are still OCR'd as before", async () => {
    const file = path.join(dir, "a.pdf");
    await makePdf(file, [{ imageWords: "LIGHTHOUSE KEEPER" }, { lines: [CLEAN] }], dir);
    const pages = await read(file, options());
    expect(pages.map((p) => [p.source, p.ocrReason])).toEqual([["ocr", "no-text-layer"], ["text", null]]);
    expect(pages[0].ocrText ?? "").toMatch(/lighthouse/i);
  });
});
