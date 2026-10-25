import fs from "node:fs";
import path from "node:path";
import type { ExtractedPage } from "../../../../scripts/indexer/store";
import { beginDocument, markDocumentReady, openLibraryDb, writePages } from "../store";

/**
 * Test-only: a library index on disk at <dataDir>/library/library.db, with
 * the marker file the app looks for, built straight through the store (no
 * PDFs, no OCR).
 */

export interface FixtureDoc {
  key: string;
  pages: Array<{ layer: string; ocr?: string; label?: string }>;
  status?: "ready" | "indexing";
}

export function writeMarker(dataDir: string): void {
  fs.writeFileSync(path.join(dataDir, ".locus-data-dir"), JSON.stringify({ volumeUuid: "TEST", createdAt: "x", version: 1 }));
}

export function buildLibraryIndex(dataDir: string, docs: FixtureDoc[]): void {
  writeMarker(dataDir);
  const db = openLibraryDb(path.join(dataDir, "library", "library.db"));
  for (const d of docs) {
    const id = beginDocument(db, {
      sourceId: "folder:test",
      key: d.key,
      displayName: d.key,
      sizeBytes: 1,
      modifiedAt: null,
      sha256: d.key,
      pageCount: d.pages.length,
      ocrLang: "eng",
      settings: "x",
      encryption: null,
      scanId: 1,
    });
    const pages: ExtractedPage[] = d.pages.map((p, i) => ({
      pageNo: i + 1,
      pageLabel: p.label ?? null,
      source: p.ocr ? (p.layer ? "text+ocr" : "ocr") : "text",
      ocrReason: null,
      imageCoverage: 0,
      layerText: p.layer,
      ocrText: p.ocr ?? null,
      error: null,
    }));
    writePages(db, id, pages);
    if (d.status !== "indexing") markDocumentReady(db, id);
  }
  db.close();
}
