import type { PageSource, TextKind } from "../search/schema";

/**
 * Layout of the library index: its own SQLite file under LOCUS_DATA_DIR
 * (library/library.db), entirely separate from the session index
 * (src/lib/search/schema.ts), which the library never touches.
 *
 * The full-text tables are configured exactly like the session index's --
 * FTS5 trigram, contentless, `case_sensitive 1`, fed text folded by
 * normalize.ts -- so "exact" and "loose" mean the same in both scopes.
 *
 * Two deliberate differences, for scale:
 *
 *  - A text row's id encodes document, page and reading:
 *        docId * 2^21 + pageNo * 2 + (ocr ? 1 : 0)
 *    so a match says where it is with no page table in memory and no join,
 *    and rowid order is document order, then page order: results page with a
 *    cursor (rowid > ?) instead of collecting every hit. Limits: about a
 *    million pages per document, 2^32 documents -- inside JavaScript's exact
 *    integer range.
 *  - Only the original text (`body`) is stored. The session index also keeps
 *    the folded and loosened copies for full-scan short queries and its
 *    brute-force checker; the library recomputes them from `body` instead.
 *
 * The job queue lives in this same file on purpose: finishing a job and
 * writing its result commit in one transaction, which two separate SQLite
 * files can't do.
 */
export const LIBRARY_SCHEMA_VERSION = 1;

export const PAGE_BITS = 21;
const PAGE_FACTOR = 2 ** PAGE_BITS;
/** Highest page number a document can have (2^20 - 1). */
export const MAX_PAGE_NO = PAGE_FACTOR / 2 - 1;

export function libraryTextId(docId: number, pageNo: number, kind: TextKind): number {
  return docId * PAGE_FACTOR + pageNo * 2 + (kind === "ocr" ? 1 : 0);
}

export function splitLibraryTextId(id: number): { docId: number; pageNo: number; kind: TextKind } {
  const docId = Math.floor(id / PAGE_FACTOR);
  const rest = id - docId * PAGE_FACTOR;
  return { docId, pageNo: Math.floor(rest / 2), kind: rest % 2 === 1 ? "ocr" : "layer" };
}

/** The [first, last] text ids a document's rows can have. */
export function libraryTextIdRange(docId: number): [number, number] {
  return [docId * PAGE_FACTOR, (docId + 1) * PAGE_FACTOR - 1];
}

export type LibraryDocumentStatus = "indexing" | "ready" | "failed";

/** Why a file isn't (fully) in the index. Also the `kind` of a failures row. */
export type FailureKind =
  | "corrupt"
  | "encrypted"
  | "unreadable"
  | "too-large"
  | "too-many-pages"
  | "timeout"
  | "not-a-pdf"
  | "permission-denied"
  | "vanished"
  | "path-too-long"
  | "unreadable-filename"
  | "not-downloaded"
  | "symlink"
  | "directory-cycle"
  | "other-device"
  | "too-deep"
  | "other";

export type { PageSource };

export const LIBRARY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,
  label     TEXT NOT NULL,
  added_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY,
  source_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  size_bytes      INTEGER,
  modified_at     TEXT,
  sha256          TEXT,
  page_count      INTEGER NOT NULL DEFAULT 0,
  pages_done      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('indexing','ready','failed')),
  ocr_lang        TEXT,
  settings        TEXT,
  -- NULL, or 'restricted': opens without a password but restricts printing/copying/editing.
  encryption      TEXT,
  error           TEXT,
  last_seen_scan  INTEGER,
  indexed_at      TEXT,
  UNIQUE (source_id, key)
);
CREATE INDEX IF NOT EXISTS documents_sha256 ON documents(sha256);
CREATE INDEX IF NOT EXISTS documents_seen ON documents(source_id, last_seen_scan);
CREATE INDEX IF NOT EXISTS documents_status ON documents(status);

CREATE TABLE IF NOT EXISTS pages (
  doc_id          INTEGER NOT NULL,
  page_no         INTEGER NOT NULL,
  page_label      TEXT,
  source          TEXT NOT NULL CHECK (source IN ('text','text+ocr','ocr','blank','failed','pending-ocr')),
  ocr_reason      TEXT,
  image_coverage  REAL NOT NULL DEFAULT 0,
  layer_chars     INTEGER NOT NULL DEFAULT 0,
  ocr_chars       INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  PRIMARY KEY (doc_id, page_no)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS texts (
  id    INTEGER PRIMARY KEY,
  body  TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS texts_exact USING fts5(
  search, content='', contentless_delete=1, tokenize='trigram case_sensitive 1'
);
CREATE VIRTUAL TABLE IF NOT EXISTS texts_loose USING fts5(
  loose, content='', contentless_delete=1, tokenize='trigram case_sensitive 1'
);

-- One live job per file at most. A change that arrives while the file is
-- being worked on sets requeue, so it's redone right after.
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL,
  key           TEXT NOT NULL,
  locator       TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('index','delete')),
  size_bytes    INTEGER,
  modified_at   TEXT,
  scan_id       INTEGER,
  state         TEXT NOT NULL CHECK (state IN ('pending','running')),
  requeue       INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  not_before    TEXT,
  last_error    TEXT,
  enqueued_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (source_id, key)
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, not_before, id);

-- The latest problem per file: why it isn't (fully) indexed.
-- size/mtime: a failure is only retried once the file changes (or with
-- --retry-failed), not on every rescan.
CREATE TABLE IF NOT EXISTS failures (
  source_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  message         TEXT,
  size_bytes      INTEGER,
  modified_at     TEXT,
  last_seen_scan  INTEGER,
  at              TEXT NOT NULL,
  PRIMARY KEY (source_id, key)
);
CREATE INDEX IF NOT EXISTS failures_kind ON failures(kind);

CREATE TABLE IF NOT EXISTS scans (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  completed     INTEGER NOT NULL DEFAULT 0,
  files_seen    INTEGER NOT NULL DEFAULT 0,
  queued        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  others        INTEGER NOT NULL DEFAULT 0,
  aborted_reason TEXT
);
`;
