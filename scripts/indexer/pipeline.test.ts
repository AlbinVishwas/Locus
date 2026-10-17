import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { search } from "../../src/lib/search/query";
import type { IndexerConfig } from "./config";
import { writeFixturePdf } from "./fixtures";
import { runIndexer } from "./indexer";
import { compare, loadCorpus, sampleQueries } from "./oracle";
import { buildReport } from "./report";

/**
 * End to end: real PDFs (synthetic, generated here) through the real
 * poppler + tesseract pipeline into a real index, then searched.
 *
 * Needs `brew install poppler tesseract`. Missing tools fail the suite with
 * a clear message rather than skipping it quietly; set SKIP_OCR_TESTS=1 to
 * skip on purpose.
 */

const skip = process.env.SKIP_OCR_TESTS === "1";

function assertToolsInstalled() {
  const missing = ["pdfinfo", "pdftotext", "pdftoppm", "pdfimages", "tesseract"].filter((tool) => {
    try {
      execFileSync("which", [tool], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `Pipeline tests need ${missing.join(", ")} (brew install poppler tesseract). ` +
        `Set SKIP_OCR_TESTS=1 to skip them deliberately.`
    );
  }
}

let root: string;

function configFor(name: string, overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  const dir = path.join(root, name);
  return {
    tendersDir: path.join(dir, "pdfs"),
    indexPath: path.join(dir, "index", "search.db"),
    ocrCachePath: path.join(dir, "index", "ocr-cache.db"),
    ocrLang: "eng",
    // The heuristic policy, so each OCR reason can be checked on its own;
    // the "all" policy has its own test below.
    ocrPages: "auto",
    ocrDpi: 300,
    concurrency: 4,
    pageTimeoutMs: 60_000,
    minTextChars: 30,
    mixedImageCoverage: 0.3,
    blankMaxInk: 0.00005,
    ...overrides,
  };
}

const quiet = { log: () => {} };
const keys = (db: Database.Database, q: string, mode: "exact" | "loose" = "exact") =>
  search(db, q, { mode, offset: 0, limit: 1000 }).hits.map((h) => `${h.filename}#${h.pageNo}`);

describe.skipIf(skip)("indexer pipeline", () => {
  const config = () => configFor("main");

  beforeAll(async () => {
    assertToolsInstalled();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tender-pipeline-"));
    const c = config();
    fs.mkdirSync(c.tendersDir, { recursive: true });
    const work = root;

    await writeFixturePdf(
      path.join(c.tendersDir, "alpha.pdf"),
      [
        {
          lines: [
            "The bidder shall pay the earnest money",
            "deposit before the due date of this tender.",
            "Tender No. 26-2080 dated 01.09.2026",
          ],
        },
        { imageWords: "QUOKKA SENTINEL" },
        {},
        {
          lines: ["This page has a typed header line, long enough to count."],
          imageWords: "PLATYPUS WOMBAT",
          imageHeight: 0.7,
        },
      ],
      { labels: true, workDir: work }
    );
    await writeFixturePdf(
      path.join(c.tendersDir, "beta.pdf"),
      [{ lines: ["Reference 26/2080 appears here. Rs. 5 lakh is the EMD amount."] }],
      { workDir: work }
    );
    await writeFixturePdf(
      path.join(c.tendersDir, "Tender_No_26-2080-annex.pdf"),
      [{ lines: ["A schedule page with no tender number inside the text."] }],
      { workDir: work }
    );
    fs.writeFileSync(path.join(c.tendersDir, "corrupt.pdf"), "%PDF-1.4\nthis is not really a pdf\n");

    await runIndexer(c, quiet);
  }, 180_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  const open = () => new Database(config().indexPath, { readonly: true });

  it("gives every page a row with the right source, and reports the corrupt PDF", () => {
    const report = buildReport(config().indexPath);
    const alpha = report.documents.find((d) => d.filename === "alpha.pdf")!;
    expect(alpha.pageCount).toBe(4);
    expect(alpha.bySource).toEqual({ text: 1, "text+ocr": 1, ocr: 1, blank: 1, failed: 0 });
    expect(alpha.ocrPages.map((p) => [p.pageNo, p.reason])).toEqual([
      [2, "no-text-layer"],
      [4, "image-coverage"],
    ]);
    expect(alpha.blankPages).toEqual([3]);

    const corrupt = report.documents.find((d) => d.filename === "corrupt.pdf")!;
    expect(corrupt.error).toContain("cannot open PDF");
    // A document that can't be opened is flagged, never silently dropped.
    expect(report.missingPages).toEqual(["corrupt.pdf"]);
  });

  it("stores printed page labels alongside physical page numbers", () => {
    const db = open();
    const labels = db
      .prepare(
        "SELECT page_no, page_label FROM pages p JOIN documents d ON d.id = p.doc_id WHERE filename = 'alpha.pdf' ORDER BY page_no"
      )
      .raw()
      .all();
    db.close();
    expect(labels).toEqual([[1, "i"], [2, "ii"], [3, "A-1"], [4, "A-2"]]);
  });

  it("finds a phrase that crosses a line break", () => {
    const db = open();
    expect(keys(db, "earnest money deposit")).toEqual(["alpha.pdf#1"]);
    db.close();
  });

  it("finds a query that exists only on an OCR page, and flags it", () => {
    const db = open();
    const result = search(db, "quokka sentinel", { mode: "exact", offset: 0, limit: 10 });
    db.close();
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      filename: "alpha.pdf",
      pageNo: 2,
      pageLabel: "ii",
      source: "ocr",
      ocrOnly: true,
    });
  });

  it("OCRs a mixed page and keeps both readings", () => {
    const db = open();
    const viaOcr = search(db, "platypus", { mode: "exact", offset: 0, limit: 10 }).hits;
    const viaLayer = search(db, "typed header line", { mode: "exact", offset: 0, limit: 10 }).hits;
    db.close();
    expect(viaOcr.map((h) => [h.pageNo, h.source, h.ocrOnly])).toEqual([[4, "text+ocr", true]]);
    expect(viaLayer.map((h) => [h.pageNo, h.ocrOnly])).toEqual([[4, false]]);
  });

  it("keeps punctuation exact: 26-2080 vs 26/2080", () => {
    const db = open();
    expect(keys(db, "26-2080")).toEqual(["alpha.pdf#1"]);
    expect(keys(db, "26/2080")).toEqual(["beta.pdf#1"]);
    expect(keys(db, "26 2080", "loose").sort()).toEqual(["alpha.pdf#1", "beta.pdf#1"]);
    db.close();
  });

  it("answers a 2-character query completely", () => {
    const db = open();
    const result = search(db, "Rs", { mode: "exact", offset: 0, limit: 100 });
    expect(result.usedFullScan).toBe(true);
    expect(result.hits.map((h) => h.filename)).toContain("beta.pdf");
    expect(compare(db, loadCorpus(db), "Rs", "exact")).toBeNull();
    db.close();
  });

  it("finds a filename-only match", () => {
    const db = open();
    const result = search(db, "annex", { mode: "exact", offset: 0, limit: 10 });
    db.close();
    expect(result.totalPages).toBe(0);
    expect(result.documents).toEqual([
      expect.objectContaining({ filename: "Tender_No_26-2080-annex.pdf", filenameMatch: true, hitCount: 0 }),
    ]);
  });

  it("agrees with brute force on sampled queries", () => {
    const db = open();
    const corpus = loadCorpus(db);
    const disagreements = sampleQueries(corpus, 300, 11)
      .flatMap((q) => [compare(db, corpus, q, "exact"), compare(db, corpus, q, "loose")])
      .filter(Boolean);
    db.close();
    expect(disagreements).toEqual([]);
  });

  it("skips unchanged files on the next run", async () => {
    const summary = await runIndexer(config(), quiet);
    expect(summary.unchanged.sort()).toEqual(["Tender_No_26-2080-annex.pdf", "alpha.pdf", "beta.pdf"]);
    // The corrupt file failed last time, so it is retried; nothing is OCR'd.
    expect(summary.updated).toEqual(["corrupt.pdf"]);
    expect(summary.ocrRun).toBe(0);
  });

  it("re-indexes a modified file: old text gone, new text found", async () => {
    await writeFixturePdf(
      path.join(config().tendersDir, "beta.pdf"),
      [{ lines: ["Reference 99/1111 replaces the old number entirely."] }],
      { workDir: root }
    );
    const summary = await runIndexer(config(), quiet);
    expect(summary.updated).toContain("beta.pdf");
    const db = open();
    expect(keys(db, "26/2080")).toEqual([]);
    expect(keys(db, "99/1111")).toEqual(["beta.pdf#1"]);
    db.close();
  });

  it("removes a deleted file from the index", async () => {
    fs.rmSync(path.join(config().tendersDir, "Tender_No_26-2080-annex.pdf"));
    const summary = await runIndexer(config(), quiet);
    expect(summary.removed).toEqual(["Tender_No_26-2080-annex.pdf"]);
    const db = open();
    expect(search(db, "annex", { mode: "exact", offset: 0, limit: 10 }).documents).toEqual([]);
    expect(keys(db, "schedule page")).toEqual([]);
    expect(db.prepare("SELECT count(*) FROM texts_exact").pluck().get()).toBe(
      db.prepare("SELECT count(*) FROM texts").pluck().get()
    );
    db.close();
  });

  it("follows a rename without re-extracting or re-OCRing", async () => {
    const c = config();
    fs.renameSync(path.join(c.tendersDir, "alpha.pdf"), path.join(c.tendersDir, "alpha-renamed.pdf"));
    const summary = await runIndexer(c, quiet);
    expect(summary.renamed).toEqual([{ from: "alpha.pdf", to: "alpha-renamed.pdf" }]);
    expect(summary.ocrRun).toBe(0);
    const db = open();
    expect(keys(db, "quokka")).toEqual(["alpha-renamed.pdf#2"]);
    db.close();
  });

  it("re-indexes unchanged files when OCR_PAGES changes, OCRing every text page", async () => {
    const summary = await runIndexer({ ...config(), ocrPages: "all" }, quiet);
    expect(summary.unchanged).toEqual([]);
    expect(summary.updated.sort()).toEqual(["alpha-renamed.pdf", "beta.pdf", "corrupt.pdf"]);
    const alpha = buildReport(config().indexPath).documents.find((d) => d.filename === "alpha-renamed.pdf")!;
    // Page 1 (plain text) is now OCR'd too; the blank page still isn't.
    expect(alpha.bySource).toEqual({ text: 0, "text+ocr": 2, ocr: 1, blank: 1, failed: 0 });
    expect(alpha.ocrPages.map((p) => [p.pageNo, p.reason])).toEqual([
      [1, "all-pages"],
      [2, "no-text-layer"],
      [4, "image-coverage"],
    ]);
    const db = open();
    // Text-layer matches are still reported as text-layer matches, not OCR-only.
    const hit = search(db, "earnest money deposit", { mode: "exact", offset: 0, limit: 10 }).hits[0];
    db.close();
    expect(hit).toMatchObject({ pageNo: 1, source: "text+ocr", ocrOnly: false });
    expect(hit.matchedIn).toContain("layer");
  });

  it("rebuilds from scratch with force, reusing cached OCR", async () => {
    const summary = await runIndexer(config(), { ...quiet, force: true });
    expect(summary.ocrRun).toBe(0);
    expect(summary.ocrCached).toBe(2);
    const db = open();
    expect(keys(db, "quokka")).toEqual(["alpha-renamed.pdf#2"]);
    db.close();
  });
});

describe.skipIf(skip)("indexer pipeline: failures", () => {
  it("records a page whose OCR fails as failed, keeps its text layer, and carries on", async () => {
    assertToolsInstalled();
    root ??= fs.mkdtempSync(path.join(os.tmpdir(), "tender-pipeline-"));
    // A language tesseract doesn't have makes every OCR call fail.
    const c = configFor("failing", { ocrLang: "zzznotalanguage" });
    fs.mkdirSync(c.tendersDir, { recursive: true });
    await writeFixturePdf(
      path.join(c.tendersDir, "gamma.pdf"),
      [
        { lines: ["An ordinary text page that needs no OCR at all."] },
        { imageWords: "UNREADABLE" },
        { lines: ["A text page with an image too, long enough to count."], imageWords: "MIXED", imageHeight: 0.7 },
      ],
      { workDir: root }
    );

    await runIndexer(c, quiet);
    const gamma = buildReport(c.indexPath).documents[0];
    expect(gamma.bySource).toEqual({ text: 1, "text+ocr": 0, ocr: 0, blank: 0, failed: 2 });
    expect(gamma.failedPages.map((p) => p.pageNo)).toEqual([2, 3]);
    expect(gamma.failedPages[0].error).toContain("ocr: tesseract failed");

    const db = new Database(c.indexPath, { readonly: true });
    // The failed mixed page's text layer is still searchable.
    expect(keys(db, "image too")).toEqual(["gamma.pdf#3"]);
    expect(keys(db, "ordinary text page")).toEqual(["gamma.pdf#1"]);
    db.close();
  }, 120_000);
});
