import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixturePdf } from "../../../../scripts/indexer/fixtures";
import { GET, POST } from "@/app/api/uploads/route";

/**
 * A file is searchable as soon as its text layer is indexed, and says so before its scanned pages are
 * read; and a picked folder's file sent twice (a browser retrying after a dropped connection) is
 * answered with the copy already there. Needs poppler + tesseract (SKIP_OCR_TESTS=1 skips it).
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-upload-searchable-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
  process.env.LOCUS_ENABLE_UPLOADS = "true";
  process.env.OCR_CONCURRENCY = "2";
  delete process.env.OCR_CACHE_PATH;
});

afterEach(async () => {
  const { _resetWritableDbForTests } = await import("@/lib/uploads/writableDb");
  _resetWritableDbForTests();
  const { _resetSharedContextForTests } = await import("@/lib/uploads/pipeline");
  _resetSharedContextForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.LOCUS_ENABLE_UPLOADS;
  delete process.env.OCR_CONCURRENCY;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function send(conversationId: string, bytes: Buffer, name: string, pickedPath?: string) {
  const form = new FormData();
  form.set("conversationId", conversationId);
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
  if (pickedPath) form.set("path", pickedPath);
  const res = await POST(new Request("http://localhost/api/uploads", { method: "POST", body: form }));
  expect(res.status).toBe(200);
  return (await res.text()).split("\n\n").filter((c) => c.trim() && !c.startsWith(":"));
}

async function scannedPdf(): Promise<Buffer> {
  const work = fs.mkdtempSync(path.join(dir, "fixture-"));
  const file = path.join(work, "scan.pdf");
  await writeFixturePdf(file, [{ lines: ["Cover page with a typed line"] }, { imageWords: "Silicone gasket seating" }], { workDir: work });
  return fs.readFileSync(file);
}

describe.skipIf(skipOcr)("searchable now", () => {
  it("announces the file as searchable, as a named event, before its scanned pages are read", async () => {
    const chunks = await send("conv-1", await scannedPdf(), "scan.pdf");
    const i = chunks.findIndex((c) => c.startsWith("event: searchable\n"));
    expect(i).toBeGreaterThan(-1);
    const data = JSON.parse(chunks[i].split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(data).toMatchObject({ type: "searchable", docId: 1, pageCount: 2 });
    expect(data.ocrPages).toBeGreaterThanOrEqual(1);
    // After the document is written, before the OCR progress and the final ready.
    const order = chunks.map((c) => (c.startsWith("event: searchable") ? "searchable" : (JSON.parse(c.slice(6)).stage ?? JSON.parse(c.slice(6)).type)));
    expect(order.indexOf("indexing")).toBeLessThan(order.indexOf("searchable"));
    expect(order.indexOf("searchable")).toBeLessThan(order.indexOf("running-ocr"));
    expect(order[order.length - 1]).toBe("ready");
  });

  it("answers a picked folder's file sent twice with the copy already there", async () => {
    const bytes = await scannedPdf();
    await send("fld_abc", bytes, "scan.pdf", "Pack/scan.pdf");
    const again = await send("fld_abc", bytes, "scan.pdf", "Pack/scan.pdf");
    expect(again.some((c) => c.includes('"type":"ready"'))).toBe(true);
    // No reading, indexing or OCR the second time.
    expect(again.some((c) => c.includes('"stage":"reading"') || c.includes("running-ocr"))).toBe(false);
    const list = await GET(new Request("http://localhost/api/uploads?conversationId=fld_abc"));
    const { documents } = (await list.json()) as { documents: Array<{ originalFilename: string }> };
    expect(documents).toHaveLength(1);
    expect(documents[0].originalFilename).toBe("Pack/scan.pdf");
  });

  it("still adds a second copy of the same file to an ordinary session, as before", async () => {
    const bytes = await scannedPdf();
    await send("conv-2", bytes, "scan.pdf");
    await send("conv-2", bytes, "scan.pdf");
    const list = await GET(new Request("http://localhost/api/uploads?conversationId=conv-2"));
    const { documents } = (await list.json()) as { documents: unknown[] };
    expect(documents).toHaveLength(2);
  });
});
