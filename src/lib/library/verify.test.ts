import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import { mulberry32 } from "./pipeline";
import { beginDocument, deleteLibraryDocument, markDocumentReady, openLibraryDb, writePages } from "./store";
import { verifyLibrary } from "./verify";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-verify-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const WORDS = ["tender", "earnest", "money", "deposit", "26-2080", "26/2080", "Rs.", "₹5,000", "bank", "guarantee", "निविदा", "Ünïcödé", "clause", "A/B-C"];

function page(pageNo: number, layer: string, ocr: string | null = null): ExtractedPage {
  return { pageNo, pageLabel: null, source: ocr ? "text+ocr" : "text", ocrReason: null, imageCoverage: 0, layerText: layer, ocrText: ocr, error: null };
}

function build(docs: number) {
  const db = openLibraryDb(path.join(dir, "library.db"));
  const rng = mulberry32(3);
  const text = () => Array.from({ length: 30 }, () => WORDS[Math.floor(rng() * WORDS.length)]).join(rng() < 0.5 ? " " : "  ");
  for (let d = 0; d < docs; d++) {
    const id = beginDocument(db, { sourceId: "s", key: `doc${d}`, displayName: `doc${d}`, sizeBytes: 1, modifiedAt: null, sha256: `h${d}`, pageCount: 3, ocrLang: "eng", settings: "x", encryption: null, scanId: 1 });
    writePages(db, id, [page(1, text()), page(2, text(), text()), page(3, "")]);
    markDocumentReady(db, id);
  }
  return db;
}

describe("verifyLibrary", () => {
  it("finds no disagreements in a correctly written index, including after deletes and rewrites", () => {
    const db = build(60);
    // Rewrite one document and delete another: their full-text rows must follow.
    const rewritten = beginDocument(db, { sourceId: "s", key: "doc5", displayName: "doc5", sizeBytes: 1, modifiedAt: null, sha256: "new", pageCount: 1, ocrLang: "eng", settings: "x", encryption: null, scanId: 2 });
    writePages(db, rewritten, [page(1, "completely different words now")]);
    markDocumentReady(db, rewritten);
    deleteLibraryDocument(db, 7);

    const r = verifyLibrary(db, { documents: 40, queries: 300 });
    expect(r.documents).toBe(40);
    expect(r.comparisons).toBeGreaterThan(300);
    expect(r.disagreements).toEqual([]);
    expect(r.rowCounts.exact).toBe(r.rowCounts.texts);
    expect(r.rowCounts.loose).toBe(r.rowCounts.texts);
    db.close();
  });

  it("does catch a corrupted index (a full-text row left behind for deleted text)", () => {
    const db = build(5);
    const id = db.prepare("SELECT id FROM texts ORDER BY id LIMIT 1").pluck().get() as number;
    // Delete the stored text but leave its full-text rows: what a buggy delete would do.
    db.prepare("DELETE FROM texts WHERE id = ?").run(id);
    const r = verifyLibrary(db, { documents: 5, queries: 300 });
    expect(r.rowCounts.texts).toBe(r.rowCounts.exact - 1);
    expect(r.disagreements.length).toBeGreaterThan(0);
    db.close();
  });
});
