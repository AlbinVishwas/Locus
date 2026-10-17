import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { foldCase, loosen, normalizeText } from "../../src/lib/search/normalize";
import { SCHEMA_SQL, SCHEMA_VERSION, type PageSource } from "../../src/lib/search/schema";

/**
 * Writing the index. Only the indexer (and tests) use this; the app opens the
 * index read-only and never imports this file.
 */

export interface ExtractedPage {
  pageNo: number;
  pageLabel: string | null;
  source: PageSource;
  ocrReason: string | null;
  imageCoverage: number;
  /** Raw text as extracted; normalized here, on the way in. */
  layerText: string;
  ocrText: string | null;
  error: string | null;
}

export interface ExtractedDocument {
  filename: string;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  ocrLang: string;
  /** Extraction settings fingerprint (config.settingsKey). */
  settings: string;
  /** Set when the PDF couldn't be opened at all (then `pages` is empty). */
  error: string | null;
  pages: ExtractedPage[];
}

export interface StoredDocument {
  id: number;
  filename: string;
  sha256: string;
  settings: string;
  error: string | null;
}

export function openIndex(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get();
  if (version === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (version !== String(SCHEMA_VERSION)) {
    db.close();
    throw new Error(
      `Index at ${file} has schema version ${version}, this code writes ${SCHEMA_VERSION}. ` +
        `Rebuild it with: npm run index -- --force`
    );
  }
  return db;
}

export function storedDocuments(db: Database.Database): StoredDocument[] {
  return db
    .prepare("SELECT id, filename, sha256, settings, error FROM documents")
    .all() as StoredDocument[];
}

/** Removes a document and everything derived from it, including index rows. */
export function deleteDocument(db: Database.Database, docId: number): void {
  const textIds = db
    .prepare("SELECT t.id FROM texts t JOIN pages p ON p.id = t.page_id WHERE p.doc_id = ?")
    .pluck()
    .all(docId) as number[];
  const delExact = db.prepare("DELETE FROM texts_exact WHERE rowid = ?");
  const delLoose = db.prepare("DELETE FROM texts_loose WHERE rowid = ?");
  for (const id of textIds) {
    delExact.run(id);
    delLoose.run(id);
  }
  // pages and texts follow through ON DELETE CASCADE.
  db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
}

export function renameDocument(db: Database.Database, docId: number, filename: string): void {
  const folded = foldCase(normalizeText(filename));
  db.prepare(
    "UPDATE documents SET filename = ?, filename_search = ?, filename_loose = ? WHERE id = ?"
  ).run(filename, folded, loosen(folded), docId);
}

/**
 * Replaces whatever is stored under this filename with `doc`, in a single
 * transaction: a crash halfway leaves the old version intact, never half of
 * each.
 */
export function replaceDocument(db: Database.Database, doc: ExtractedDocument): void {
  const insertDoc = db.prepare(`
    INSERT INTO documents
      (filename, filename_search, filename_loose, sha256, size_bytes, page_count, ocr_lang, settings, error, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPage = db.prepare(`
    INSERT INTO pages
      (doc_id, page_no, page_label, source, ocr_reason, image_coverage, layer_chars, ocr_chars, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertText = db.prepare(
    "INSERT INTO texts (page_id, kind, body, search, loose) VALUES (?, ?, ?, ?, ?)"
  );
  const insertExact = db.prepare("INSERT INTO texts_exact (rowid, search) VALUES (?, ?)");
  const insertLoose = db.prepare("INSERT INTO texts_loose (rowid, loose) VALUES (?, ?)");
  const existing = db.prepare("SELECT id FROM documents WHERE filename = ?").pluck();

  db.transaction(() => {
    const oldId = existing.get(doc.filename) as number | undefined;
    if (oldId !== undefined) deleteDocument(db, oldId);

    const filenameFolded = foldCase(normalizeText(doc.filename));
    const docId = Number(
      insertDoc.run(
        doc.filename,
        filenameFolded,
        loosen(filenameFolded),
        doc.sha256,
        doc.sizeBytes,
        doc.pageCount,
        doc.ocrLang,
        doc.settings,
        doc.error,
        new Date().toISOString()
      ).lastInsertRowid
    );

    for (const page of doc.pages) {
      const layer = normalizeText(page.layerText);
      const ocr = page.ocrText === null ? "" : normalizeText(page.ocrText);
      const pageId = Number(
        insertPage.run(
          docId,
          page.pageNo,
          page.pageLabel,
          page.source,
          page.ocrReason,
          page.imageCoverage,
          layer.replace(/ /g, "").length,
          ocr.replace(/ /g, "").length,
          page.error
        ).lastInsertRowid
      );

      for (const [kind, body] of [["layer", layer], ["ocr", ocr]] as const) {
        if (body === "") continue;
        const search = foldCase(body);
        const loose = loosen(search);
        const textId = insertText.run(pageId, kind, body, search, loose).lastInsertRowid;
        insertExact.run(textId, search);
        insertLoose.run(textId, loose);
      }
    }
  })();
}
