import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import { foldCase, loosen, normalizeText } from "../search/normalize";
import {
  DOC_SEQ_BITS,
  docIdRange,
  LIBRARY_SCHEMA_SQL,
  LIBRARY_SCHEMA_VERSION,
  libraryTextId,
  libraryTextIdRange,
  MAX_DOC_SEQ,
  MAX_SOURCE_ORDINAL,
  type FailureKind,
} from "./schema";

/**
 * Writing the library index. One writer only (`npm run index:library`,
 * holding library/indexer.lock); the app reads it through its own
 * read-only connection.
 */

export function openLibraryDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  // FULL + fullfsync: on macOS a plain fsync doesn't force the drive to
  // write its cache, and the drive being pulled mid-run is a case this is
  // built to survive.
  db.pragma("synchronous = FULL");
  db.pragma("fullfsync = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(LIBRARY_SCHEMA_SQL);
  const version = db.prepare("SELECT value FROM meta WHERE key = 'library_schema_version'").pluck().get();
  if (version === undefined) {
    db.transaction(() => {
      db.prepare("INSERT INTO meta (key, value) VALUES ('library_schema_version', ?)").run(String(LIBRARY_SCHEMA_VERSION));
      db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ordinal', '1')").run();
    })();
  } else if (version === "1") {
    migrateV1ToV2(db);
  } else if (version !== String(LIBRARY_SCHEMA_VERSION)) {
    db.close();
    throw new Error(`Library index at ${file} has schema version ${version}; this code writes ${LIBRARY_SCHEMA_VERSION}.`);
  }
  return db;
}

/**
 * v1 -> v2: sources get an `ordinal` and a `name`. Everything indexed under
 * v1 has document ids below 2^24, i.e. it already lives in ordinal 0's
 * range, so no document, page or full-text row moves; the v1 sources are
 * simply all given ordinal 0 (they can be searched together, not one by one,
 * which is the only thing the range gives up). One transaction.
 */
function migrateV1ToV2(db: Database.Database): void {
  db.transaction(() => {
    const columns = (db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes("ordinal")) db.exec("ALTER TABLE sources ADD COLUMN ordinal INTEGER");
    if (!columns.includes("name")) db.exec("ALTER TABLE sources ADD COLUMN name TEXT");
    db.exec("UPDATE sources SET ordinal = 0 WHERE ordinal IS NULL");
    db.exec("UPDATE sources SET name = kind WHERE name IS NULL");
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ordinal', '1')").run();
    db.prepare("UPDATE meta SET value = ? WHERE key = 'library_schema_version'").run(String(LIBRARY_SCHEMA_VERSION));
  })();
}

/** True if SQLite's own consistency check passes (run after the drive comes back). */
export function quickCheck(db: Database.Database): boolean {
  return db.prepare("PRAGMA quick_check").pluck().get() === "ok";
}

const now = () => new Date().toISOString();

export function bumpGeneration(db: Database.Database): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('generation', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  ).run();
}

/**
 * Registers a source (or refreshes its label/name) and returns its ordinal:
 * the one it already has, or the next never-used one (ordinals are never
 * reused, even after a source is removed, so an id range is never shared by
 * two different sources over time).
 */
export function registerSource(
  db: Database.Database,
  source: { id: string; kind: string; label: string; name?: string }
): number {
  return db.transaction(() => {
    const existing = db.prepare("SELECT ordinal FROM sources WHERE id = ?").get(source.id) as { ordinal: number | null } | undefined;
    if (existing) {
      db.prepare("UPDATE sources SET label = ?, name = COALESCE(?, name) WHERE id = ?").run(source.label, source.name ?? null, source.id);
      return existing.ordinal ?? 0;
    }
    const next = Number(db.prepare("SELECT value FROM meta WHERE key = 'next_ordinal'").pluck().get() ?? 1);
    if (next > MAX_SOURCE_ORDINAL) throw new Error(`A library can have at most ${MAX_SOURCE_ORDINAL} sources over its lifetime.`);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'next_ordinal'").run(String(next + 1));
    db.prepare("INSERT INTO sources (id, kind, label, added_at, ordinal, name) VALUES (?, ?, ?, ?, ?, ?)").run(
      source.id,
      source.kind,
      source.label,
      now(),
      next,
      source.name ?? source.kind
    );
    return next;
  })();
}

export interface SourceRow {
  id: string;
  kind: string;
  name: string;
  ordinal: number;
}

export function listSources(db: Database.Database): SourceRow[] {
  return db.prepare("SELECT id, kind, coalesce(name, kind) AS name, coalesce(ordinal, 0) AS ordinal FROM sources ORDER BY ordinal, id").all() as SourceRow[];
}

/** The next unused document id inside a source's range (ordinal 0 for a source that was never registered). */
function nextDocId(db: Database.Database, sourceId: string): number {
  const ordinal = (db.prepare("SELECT ordinal FROM sources WHERE id = ?").pluck().get(sourceId) as number | null | undefined) ?? 0;
  const [lo, hi] = docIdRange(ordinal);
  const max = db.prepare("SELECT max(id) FROM documents WHERE id BETWEEN ? AND ?").pluck().get(lo, hi) as number | null;
  const id = max === null ? lo + 1 : max + 1;
  if (id - lo > MAX_DOC_SEQ) throw new Error(`This source has more than ${MAX_DOC_SEQ.toLocaleString("en-US")} documents (2^${DOC_SEQ_BITS}); the library can't index more.`);
  return id;
}

/**
 * Removes a batch of a source's indexed content -- documents, pages, texts,
 * full-text rows -- and returns how many documents are left. Only the
 * library's own index entries: the files or database behind the source are
 * never touched. Call until it returns 0, then dropSource().
 */
export function removeSourceContent(db: Database.Database, sourceId: string, batch = 100): number {
  const ids = db.prepare("SELECT id FROM documents WHERE source_id = ? LIMIT ?").pluck().all(sourceId, batch) as number[];
  db.transaction(() => {
    for (const id of ids) deleteLibraryDocument(db, id);
  })();
  return Number(db.prepare("SELECT count(*) FROM documents WHERE source_id = ?").pluck().get(sourceId));
}

/** After removeSourceContent has emptied a source: its jobs, failures, scans, progress and registration. The ordinal stays consumed. */
export function dropSource(db: Database.Database, sourceId: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM jobs WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM failures WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM scans WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
    bumpGeneration(db);
  })();
}

// --- scans -----------------------------------------------------------------

export function startScan(db: Database.Database, sourceId: string): number {
  return Number(db.prepare("INSERT INTO scans (source_id, started_at) VALUES (?, ?)").run(sourceId, now()).lastInsertRowid);
}

export function finishScan(
  db: Database.Database,
  scanId: number,
  stats: { filesSeen: number; queued: number; skipped: number; others: number },
  outcome: { completed: boolean; abortedReason?: string }
): void {
  db.prepare(
    `UPDATE scans SET finished_at = ?, completed = ?, files_seen = ?, queued = ?, skipped = ?, others = ?, aborted_reason = ?
     WHERE id = ?`
  ).run(now(), outcome.completed ? 1 : 0, stats.filesSeen, stats.queued, stats.skipped, stats.others, outcome.abortedReason ?? null, scanId);
}

// --- documents ---------------------------------------------------------------

export interface KnownDocument {
  id: number;
  key: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  sha256: string | null;
  status: "indexing" | "ready" | "failed";
  settings: string | null;
  lastSeenScan: number | null;
}

/** Looks up a batch of keys at once (the scan's change detection), through the unique index. */
export function knownDocuments(db: Database.Database, sourceId: string, keys: string[]): Map<string, KnownDocument> {
  const out = new Map<string, KnownDocument>();
  const stmt = db.prepare(
    `SELECT id, key, size_bytes AS sizeBytes, modified_at AS modifiedAt, sha256, status, settings, last_seen_scan AS lastSeenScan
     FROM documents WHERE source_id = ? AND key = ?`
  );
  for (const key of keys) {
    const row = stmt.get(sourceId, key) as KnownDocument | undefined;
    if (row) out.set(key, row);
  }
  return out;
}

export function markSeen(db: Database.Database, sourceId: string, keys: string[], scanId: number): void {
  const stmt = db.prepare("UPDATE documents SET last_seen_scan = ? WHERE source_id = ? AND key = ?");
  db.transaction(() => {
    for (const key of keys) stmt.run(scanId, sourceId, key);
  })();
}

/** Removes a document's pages, texts and full-text rows (not the document row itself). */
function clearDocumentContent(db: Database.Database, docId: number): void {
  const [lo, hi] = libraryTextIdRange(docId);
  const ids = db.prepare("SELECT id FROM texts WHERE id BETWEEN ? AND ?").pluck().all(lo, hi) as number[];
  const delExact = db.prepare("DELETE FROM texts_exact WHERE rowid = ?");
  const delLoose = db.prepare("DELETE FROM texts_loose WHERE rowid = ?");
  for (const id of ids) {
    delExact.run(id);
    delLoose.run(id);
  }
  db.prepare("DELETE FROM texts WHERE id BETWEEN ? AND ?").run(lo, hi);
  db.prepare("DELETE FROM pages WHERE doc_id = ?").run(docId);
}

export function deleteLibraryDocument(db: Database.Database, docId: number): void {
  clearDocumentContent(db, docId);
  db.prepare("DELETE FROM documents WHERE id = ?").run(docId);
  bumpGeneration(db);
}

export interface BeginDocument {
  sourceId: string;
  key: string;
  displayName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  sha256: string;
  pageCount: number;
  ocrLang: string;
  settings: string;
  encryption: "restricted" | null;
  scanId: number | null;
}

/**
 * Starts (or restarts) indexing one file: any earlier content for the same
 * (source, key) -- a previous version, or a run that crashed halfway -- is
 * removed first, so redoing a file can never leave two copies of it.
 */
export function beginDocument(db: Database.Database, doc: BeginDocument): number {
  return db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM documents WHERE source_id = ? AND key = ?")
      .pluck()
      .get(doc.sourceId, doc.key) as number | undefined;
    if (existing !== undefined) {
      clearDocumentContent(db, existing);
      db.prepare(
        `UPDATE documents SET display_name = ?, size_bytes = ?, modified_at = ?, sha256 = ?, page_count = ?, pages_done = 0,
           status = 'indexing', ocr_lang = ?, settings = ?, encryption = ?, error = NULL,
           last_seen_scan = COALESCE(?, last_seen_scan), indexed_at = NULL
         WHERE id = ?`
      ).run(doc.displayName, doc.sizeBytes, doc.modifiedAt, doc.sha256, doc.pageCount, doc.ocrLang, doc.settings, doc.encryption, doc.scanId, existing);
      return existing;
    }
    const id = nextDocId(db, doc.sourceId);
    db.prepare(
      `INSERT INTO documents (id, source_id, key, display_name, size_bytes, modified_at, sha256, page_count, status, ocr_lang, settings, encryption, last_seen_scan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexing', ?, ?, ?, ?)`
    ).run(id, doc.sourceId, doc.key, doc.displayName, doc.sizeBytes, doc.modifiedAt, doc.sha256, doc.pageCount, doc.ocrLang, doc.settings, doc.encryption, doc.scanId);
    return id;
  })();
}

/** Writes a chunk of extracted pages: searchable as soon as this commits. */
export function writePages(db: Database.Database, docId: number, pages: ExtractedPage[]): void {
  const insertPage = db.prepare(
    `INSERT OR REPLACE INTO pages (doc_id, page_no, page_label, source, ocr_reason, image_coverage, layer_chars, ocr_chars, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertText = db.prepare("INSERT OR REPLACE INTO texts (id, body) VALUES (?, ?)");
  const insertExact = db.prepare("INSERT INTO texts_exact (rowid, search) VALUES (?, ?)");
  const insertLoose = db.prepare("INSERT INTO texts_loose (rowid, loose) VALUES (?, ?)");
  db.transaction(() => {
    for (const page of pages) {
      // Same normalization as the session index (scripts/indexer/store.ts).
      const layer = normalizeText(page.layerText);
      const ocr = page.ocrText === null ? "" : normalizeText(page.ocrText);
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
      );
      for (const [kind, body] of [["layer", layer], ["ocr", ocr]] as const) {
        if (body === "") continue;
        const id = libraryTextId(docId, page.pageNo, kind);
        const search = foldCase(body);
        insertText.run(id, body);
        insertExact.run(id, search);
        insertLoose.run(id, loosen(search));
      }
    }
    db.prepare("UPDATE documents SET pages_done = pages_done + ? WHERE id = ?").run(pages.length, docId);
  })();
}

export function markDocumentReady(db: Database.Database, docId: number): void {
  db.prepare("UPDATE documents SET status = 'ready', indexed_at = ? WHERE id = ?").run(now(), docId);
  bumpGeneration(db);
}

/** A file whose content is unchanged (same hash): only its size/mtime moved. */
export function touchDocument(db: Database.Database, docId: number, f: { sizeBytes: number | null; modifiedAt: string | null; scanId: number | null }): void {
  db.prepare("UPDATE documents SET size_bytes = ?, modified_at = ?, last_seen_scan = COALESCE(?, last_seen_scan) WHERE id = ?").run(
    f.sizeBytes,
    f.modifiedAt,
    f.scanId,
    docId
  );
}

/** A rename: the same content under a new path. No re-extraction. */
export function renameLibraryDocument(
  db: Database.Database,
  docId: number,
  f: { key: string; displayName: string; sizeBytes: number | null; modifiedAt: string | null; scanId: number | null }
): void {
  db.prepare(
    "UPDATE documents SET key = ?, display_name = ?, size_bytes = ?, modified_at = ?, last_seen_scan = COALESCE(?, last_seen_scan) WHERE id = ?"
  ).run(f.key, f.displayName, f.sizeBytes, f.modifiedAt, f.scanId, docId);
  bumpGeneration(db);
}

/**
 * A ready document with this content that the current scan hasn't seen at
 * its old path: the candidate for "this new file is a rename of it".
 */
export function renameCandidate(db: Database.Database, sourceId: string, sha256: string, settings: string, scanId: number): number | null {
  const id = db
    .prepare(
      `SELECT id FROM documents
       WHERE source_id = ? AND sha256 = ? AND settings = ? AND status = 'ready'
         AND (last_seen_scan IS NULL OR last_seen_scan < ?)
       ORDER BY id LIMIT 1`
    )
    .pluck()
    .get(sourceId, sha256, settings, scanId) as number | undefined;
  return id ?? null;
}

/** Documents a completed scan didn't see: the files that are gone. */
export function unseenDocuments(db: Database.Database, sourceId: string, scanId: number, limit = 500): number[] {
  return db
    .prepare("SELECT id FROM documents WHERE source_id = ? AND (last_seen_scan IS NULL OR last_seen_scan < ?) LIMIT ?")
    .pluck()
    .all(sourceId, scanId, limit) as number[];
}

// --- failures ----------------------------------------------------------------

export interface FailureRecord {
  sourceId: string;
  key: string;
  displayName: string;
  kind: FailureKind;
  message: string | null;
  sizeBytes?: number | null;
  modifiedAt?: string | null;
  scanId?: number | null;
}

export function recordFailure(db: Database.Database, f: FailureRecord): void {
  db.prepare(
    `INSERT INTO failures (source_id, key, display_name, kind, message, size_bytes, modified_at, last_seen_scan, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, key) DO UPDATE SET display_name = excluded.display_name, kind = excluded.kind,
       message = excluded.message, size_bytes = excluded.size_bytes, modified_at = excluded.modified_at,
       last_seen_scan = COALESCE(excluded.last_seen_scan, failures.last_seen_scan), at = excluded.at`
  ).run(f.sourceId, f.key, f.displayName, f.kind, f.message, f.sizeBytes ?? null, f.modifiedAt ?? null, f.scanId ?? null, now());
}

/** Known failures for a batch of keys: whether a file that failed before has changed since. */
export function knownFailures(
  db: Database.Database,
  sourceId: string,
  keys: string[]
): Map<string, { kind: string; sizeBytes: number | null; modifiedAt: string | null }> {
  const out = new Map<string, { kind: string; sizeBytes: number | null; modifiedAt: string | null }>();
  const stmt = db.prepare("SELECT kind, size_bytes AS sizeBytes, modified_at AS modifiedAt FROM failures WHERE source_id = ? AND key = ?");
  for (const key of keys) {
    const row = stmt.get(sourceId, key) as { kind: string; sizeBytes: number | null; modifiedAt: string | null } | undefined;
    if (row) out.set(key, row);
  }
  return out;
}

export function markFailuresSeen(db: Database.Database, sourceId: string, keys: string[], scanId: number): void {
  const stmt = db.prepare("UPDATE failures SET last_seen_scan = ? WHERE source_id = ? AND key = ?");
  db.transaction(() => {
    for (const key of keys) stmt.run(scanId, sourceId, key);
  })();
}

/** After a completed scan: failure rows for files that are gone. Skip records (permission, symlink...) are refreshed each scan, so stale ones go too. */
export function sweepFailures(db: Database.Database, sourceId: string, scanId: number): number {
  return db.prepare("DELETE FROM failures WHERE source_id = ? AND (last_seen_scan IS NULL OR last_seen_scan < ?)").run(sourceId, scanId).changes;
}

export function clearFailure(db: Database.Database, sourceId: string, key: string): void {
  db.prepare("DELETE FROM failures WHERE source_id = ? AND key = ?").run(sourceId, key);
}

export function failDocument(db: Database.Database, docId: number, message: string): void {
  db.prepare("UPDATE documents SET status = 'failed', error = ? WHERE id = ?").run(message, docId);
  bumpGeneration(db);
}

// --- status ------------------------------------------------------------------

export interface LibraryCounts {
  documents: number;
  ready: number;
  indexing: number;
  failedDocuments: number;
  pagesIndexed: number;
  jobsPending: number;
  jobsRunning: number;
  failures: number;
  failuresByKind: Record<string, number>;
}

export function libraryCounts(db: Database.Database): LibraryCounts {
  const one = (sql: string) => Number(db.prepare(sql).pluck().get() ?? 0);
  const byKind = db.prepare("SELECT kind, count(*) AS n FROM failures GROUP BY kind").all() as Array<{ kind: string; n: number }>;
  return {
    documents: one("SELECT count(*) FROM documents"),
    ready: one("SELECT count(*) FROM documents WHERE status = 'ready'"),
    indexing: one("SELECT count(*) FROM documents WHERE status = 'indexing'"),
    failedDocuments: one("SELECT count(*) FROM documents WHERE status = 'failed'"),
    pagesIndexed: one("SELECT coalesce(sum(pages_done), 0) FROM documents"),
    jobsPending: one("SELECT count(*) FROM jobs WHERE state = 'pending'"),
    jobsRunning: one("SELECT count(*) FROM jobs WHERE state = 'running'"),
    failures: one("SELECT count(*) FROM failures"),
    failuresByKind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
  };
}
