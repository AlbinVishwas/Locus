import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { foldCase, loosen, normalizeText } from "../../src/lib/search/normalize";
import { SCHEMA_SQL, SCHEMA_VERSION, textId, type PageSource } from "../../src/lib/search/schema";

/**
 * Writing the index. The CLI indexer (scripts/index-tenders.ts) uses this for
 * the standalone tender corpus; the upload route (src/app/api/uploads) uses
 * it too, for conversation-scoped uploads -- that's the one place the app
 * itself writes to the index rather than only reading it (src/lib/search/
 * indexDb.ts's read-only connection is still what every search goes through).
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
  // Only takes effect on a brand-new file: auto_vacuum must be set before
  // any tables exist. It lets the periodic retention cleanup (deleting
  // expired uploads) reclaim freed pages with PRAGMA incremental_vacuum
  // rather than a full VACUUM, which rewrites the whole file under an
  // exclusive lock -- fine for an occasional CLI rebuild, not for a page a
  // live search request might be running against.
  const isNew = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  if (isNew) db.pragma("auto_vacuum = INCREMENTAL");
  // WAL: readers (search, via indexDb.ts's separate read-only connection)
  // don't block on a writer's transaction, and vice versa. Matters once the
  // upload route can be writing (a new document, or one page's OCR result)
  // while someone is searching -- under the default rollback journal a
  // writer briefly locks the whole file.
  db.pragma("journal_mode = WAL");
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

/**
 * Marks the index as changed. Every write goes through a function here that
 * calls this inside its transaction; search() reloads its in-memory page map
 * when the value differs from the one it loaded.
 */
function bumpGeneration(db: Database.Database): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('generation', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  ).run();
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
  bumpGeneration(db);
}

export function renameDocument(db: Database.Database, docId: number, filename: string): void {
  const folded = foldCase(normalizeText(filename));
  db.prepare(
    "UPDATE documents SET filename = ?, filename_search = ?, filename_loose = ? WHERE id = ?"
  ).run(filename, folded, loosen(folded), docId);
  bumpGeneration(db);
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
    "INSERT INTO texts (id, page_id, kind, body, search, loose) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertExact = db.prepare("INSERT INTO texts_exact (rowid, search) VALUES (?, ?)");
  const insertLoose = db.prepare("INSERT INTO texts_loose (rowid, loose) VALUES (?, ?)");
  // Only this function's own corpus (conversation_id IS NULL): an upload
  // sharing a tender's filename by coincidence must never collide with it.
  const existing = db
    .prepare("SELECT id FROM documents WHERE filename = ? AND conversation_id IS NULL")
    .pluck();

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
        const id = textId(pageId, kind);
        insertText.run(id, pageId, kind, body, search, loose);
        insertExact.run(id, search);
        insertLoose.run(id, loose);
      }
    }
    bumpGeneration(db);
  })();
}

// ---------------------------------------------------------------------------
// Uploads: documents scoped to one chat conversation. Unlike the tender
// corpus (replaceDocument, above, which writes a whole document atomically
// once everything -- including OCR -- is known), an upload is written in two
// passes: the fast one (text layer, page planning) makes it searchable
// immediately, and OCR results join page by page as they finish, so a slow
// scan doesn't hold up every other page of the same file.

export interface NewUploadedDocument {
  conversationId: string;
  originalFilename: string;
  /** Storage-safe filename actually on disk, content-addressed. */
  storedFilename: string;
  sha256: string;
  sizeBytes: number;
  ocrLang: string;
  settings: string;
  uploadedAt: string;
  expiresAt: string;
  pages: ExtractedPage[];
}

export interface UploadedDocument {
  id: number;
  conversationId: string;
  originalFilename: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  status: "ready" | "indexing" | "failed";
  uploadedAt: string;
  expiresAt: string;
  error: string | null;
}

/**
 * Writes a freshly uploaded document and every page's text-layer reading.
 * Pages that still need OCR go in as 'pending-ocr' with just the layer text
 * (if any) searchable; the document's status is 'indexing' until every such
 * page is resolved by upsertPageOcr. Returns the page ids that need OCR, in
 * page order, so the caller can queue exactly those.
 */
export function insertUploadedDocument(
  db: Database.Database,
  doc: NewUploadedDocument
): { docId: number; pendingPages: Array<{ pageId: number; pageNo: number }> } {
  const insertDoc = db.prepare(`
    INSERT INTO documents
      (filename, filename_search, filename_loose, sha256, size_bytes, page_count, ocr_lang,
       settings, error, indexed_at, conversation_id, original_filename, uploaded_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
  const insertPage = db.prepare(`
    INSERT INTO pages
      (doc_id, page_no, page_label, source, ocr_reason, image_coverage, layer_chars, ocr_chars, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertText = db.prepare(
    "INSERT INTO texts (id, page_id, kind, body, search, loose) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertExact = db.prepare("INSERT INTO texts_exact (rowid, search) VALUES (?, ?)");
  const insertLoose = db.prepare("INSERT INTO texts_loose (rowid, loose) VALUES (?, ?)");

  return db.transaction(() => {
    const pendingCount = doc.pages.filter((p) => p.source === "pending-ocr").length;
    const filenameFolded = foldCase(normalizeText(doc.storedFilename));
    const docId = Number(
      insertDoc.run(
        doc.storedFilename,
        filenameFolded,
        loosen(filenameFolded),
        doc.sha256,
        doc.sizeBytes,
        doc.pages.length,
        doc.ocrLang,
        doc.settings,
        doc.uploadedAt,
        doc.conversationId,
        doc.originalFilename,
        doc.uploadedAt,
        doc.expiresAt,
        pendingCount > 0 ? "indexing" : "ready"
      ).lastInsertRowid
    );

    const pendingPages: Array<{ pageId: number; pageNo: number }> = [];
    for (const page of doc.pages) {
      const layer = normalizeText(page.layerText);
      const pageId = Number(
        insertPage.run(
          docId,
          page.pageNo,
          page.pageLabel,
          page.source,
          page.ocrReason,
          page.imageCoverage,
          layer.replace(/ /g, "").length,
          0,
          page.error
        ).lastInsertRowid
      );

      if (layer !== "") {
        const search = foldCase(layer);
        const loose = loosen(search);
        const id = textId(pageId, "layer");
        insertText.run(id, pageId, "layer", layer, search, loose);
        insertExact.run(id, search);
        insertLoose.run(id, loose);
      }

      if (page.source === "pending-ocr") pendingPages.push({ pageId, pageNo: page.pageNo });
    }

    bumpGeneration(db);
    return { docId, pendingPages };
  })();
}

export interface PageOcrResult {
  source: PageSource;
  ocrText: string | null;
  error: string | null;
}

/**
 * Applies one page's finished OCR result: updates its row and (if there's
 * text) adds its 'ocr' reading to the full-text index. Once no page of the
 * document is left 'pending-ocr', the document's status moves to 'ready'
 * (or 'failed' if every pending page came back with an error and no
 * reading).
 */
export function upsertPageOcr(
  db: Database.Database,
  docId: number,
  pageId: number,
  result: PageOcrResult
): void {
  const insertText = db.prepare(
    "INSERT INTO texts (id, page_id, kind, body, search, loose) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertExact = db.prepare("INSERT INTO texts_exact (rowid, search) VALUES (?, ?)");
  const insertLoose = db.prepare("INSERT INTO texts_loose (rowid, loose) VALUES (?, ?)");

  db.transaction(() => {
    const ocr = result.ocrText === null ? "" : normalizeText(result.ocrText);
    db.prepare(
      "UPDATE pages SET source = ?, ocr_reason = NULL, ocr_chars = ?, error = ? WHERE id = ?"
    ).run(result.source, ocr.replace(/ /g, "").length, result.error, pageId);

    if (ocr !== "") {
      const search = foldCase(ocr);
      const loose = loosen(search);
      const id = textId(pageId, "ocr");
      insertText.run(id, pageId, "ocr", ocr, search, loose);
      insertExact.run(id, search);
      insertLoose.run(id, loose);
    }

    const stillPending = db
      .prepare("SELECT 1 FROM pages WHERE doc_id = ? AND source = 'pending-ocr' LIMIT 1")
      .get(docId);
    if (!stillPending) {
      const anyReadable = db
        .prepare("SELECT 1 FROM pages WHERE doc_id = ? AND source != 'failed' LIMIT 1")
        .get(docId);
      db.prepare("UPDATE documents SET status = ? WHERE id = ?").run(
        anyReadable ? "ready" : "failed",
        docId
      );
    }
    bumpGeneration(db);
  })();
}

export function uploadedDocuments(db: Database.Database, conversationId: string): UploadedDocument[] {
  return db
    .prepare(
      `SELECT id, conversation_id as conversationId, original_filename as originalFilename,
              filename, sha256, size_bytes as sizeBytes, page_count as pageCount, status,
              uploaded_at as uploadedAt, expires_at as expiresAt, error
       FROM documents WHERE conversation_id = ? ORDER BY uploaded_at`
    )
    .all(conversationId) as UploadedDocument[];
}

/** Every document (any conversation, or the tender corpus) past its expiry. */
export function expiredDocuments(
  db: Database.Database,
  nowIso: string
): Array<{ id: number; sha256: string; filename: string }> {
  return db
    .prepare(
      "SELECT id, sha256, filename FROM documents WHERE expires_at IS NOT NULL AND expires_at <= ?"
    )
    .all(nowIso) as Array<{ id: number; sha256: string; filename: string }>;
}

/** Whether any *other* document still references this file's content. */
export function sha256StillReferenced(
  db: Database.Database,
  sha256: string,
  excludingDocId: number
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM documents WHERE sha256 = ? AND id != ? LIMIT 1")
      .get(sha256, excludingDocId) !== undefined
  );
}

/** Deletes every document uploaded to one conversation. Returns their sha256s (for the caller to decide what else to clean up) before the rows are gone. */
export function deleteConversationDocuments(
  db: Database.Database,
  conversationId: string
): Array<{ id: number; sha256: string }> {
  const docs = db
    .prepare("SELECT id, sha256 FROM documents WHERE conversation_id = ?")
    .all(conversationId) as Array<{ id: number; sha256: string }>;
  db.transaction(() => {
    for (const doc of docs) deleteDocument(db, doc.id);
  })();
  return docs;
}
