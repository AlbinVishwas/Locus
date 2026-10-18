/**
 * Layout of the search index file (one SQLite database).
 *
 *   documents   one row per PDF: filename, content hash, page count.
 *   pages       one row per physical page, always — even blank or failed
 *               pages get a row, so a gap is visible rather than absent.
 *   texts       the searchable text of a page. A page has up to two: its PDF
 *               text layer ("layer") and its OCR reading ("ocr"). Mixed pages
 *               keep both, so neither reading is lost. Row ids are derived
 *               from the page id (see textId).
 *   texts_exact / texts_loose
 *               the full-text indexes over texts.search / texts.loose.
 *
 * Why the trigram tokenizer: it indexes every 3-character slice of the text,
 * so a query matches anywhere — mid-word, across punctuation — exactly like a
 * plain substring search, just without reading every page. The word-based
 * alternative (unicode61) splits text into words and throws punctuation away,
 * which makes "26-2080" and "26/2080" the same query. That is the opposite of
 * what exact mode promises.
 *
 * `case_sensitive 1` switches the tokenizer's own case-folding off: the text
 * is already folded by normalize.ts, and folding it a second, slightly
 * different way would let the index and the brute-force checker disagree.
 *
 * The FTS tables are "contentless" (content=''): they hold only the index,
 * not another copy of the text, which roughly halves the file size.
 * contentless_delete=1 still lets us delete a document's rows on re-index.
 *
 * Documents belong either to the standalone tender corpus (conversation_id
 * NULL — the original `npm run index` / `/search` feature) or to one chat
 * conversation's uploads (conversation_id set to that conversation's id).
 * Search scopes to one or the other; the two never mix in one query. An
 * uploaded document additionally carries the metadata uploads need that the
 * tender corpus never did: a display name separate from its storage path,
 * when it was uploaded, when it expires, and its indexing status, so a page
 * can be searchable from its text layer while OCR for the rest is still
 * running (status 'indexing' with some pages already 'pending-ocr', moving
 * to 'ready' once every page has a final reading).
 */
export const SCHEMA_VERSION = 4;

export const PAGE_SOURCES = [
  "text",
  "text+ocr",
  "ocr",
  "blank",
  "failed",
  "pending-ocr",
] as const;
export type PageSource = (typeof PAGE_SOURCES)[number];

export const DOCUMENT_STATUSES = ["ready", "indexing", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const TEXT_KINDS = ["layer", "ocr"] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

/**
 * A text row's id is derived from its page: page id * 2, plus 1 for the OCR
 * reading. The full-text index returns only these ids, so the page and the
 * reading behind every match are known without looking anything up.
 */
export function textId(pageId: number, kind: TextKind): number {
  return pageId * 2 + (kind === "ocr" ? 1 : 0);
}

export function splitTextId(id: number): { pageId: number; kind: TextKind } {
  return { pageId: Math.floor(id / 2), kind: id % 2 === 1 ? "ocr" : "layer" };
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY,
  filename         TEXT NOT NULL,
  filename_search  TEXT NOT NULL,
  filename_loose   TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  page_count       INTEGER NOT NULL,
  ocr_lang         TEXT NOT NULL,
  settings         TEXT NOT NULL,
  error            TEXT,
  indexed_at       TEXT NOT NULL,
  -- NULL: the standalone tender corpus. Set: one chat conversation's upload.
  conversation_id  TEXT,
  -- Display name for an upload (the tender corpus has none: filename IS it).
  original_filename TEXT,
  uploaded_at      TEXT,
  expires_at       TEXT,
  status           TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','indexing','failed'))
);
-- The tender corpus still needs one row per filename; an upload's identity
-- is (conversation, content hash) instead, checked in application code
-- since SQLite can't express "unique filename only when conversation_id IS
-- NULL" as a single UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS documents_tender_filename
  ON documents(filename) WHERE conversation_id IS NULL;
CREATE INDEX IF NOT EXISTS documents_conversation ON documents(conversation_id);
CREATE INDEX IF NOT EXISTS documents_sha256 ON documents(sha256);
CREATE INDEX IF NOT EXISTS documents_expires ON documents(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pages (
  id              INTEGER PRIMARY KEY,
  doc_id          INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no         INTEGER NOT NULL,
  page_label      TEXT,
  source          TEXT NOT NULL CHECK (source IN ('text','text+ocr','ocr','blank','failed','pending-ocr')),
  ocr_reason      TEXT,
  image_coverage  REAL NOT NULL DEFAULT 0,
  layer_chars     INTEGER NOT NULL DEFAULT 0,
  ocr_chars       INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  UNIQUE (doc_id, page_no)
);

CREATE TABLE IF NOT EXISTS texts (
  id       INTEGER PRIMARY KEY,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('layer','ocr')),
  body     TEXT NOT NULL,
  search   TEXT NOT NULL,
  loose    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS texts_page ON texts(page_id);

CREATE VIRTUAL TABLE IF NOT EXISTS texts_exact USING fts5(
  search, content='', contentless_delete=1, tokenize='trigram case_sensitive 1'
);
CREATE VIRTUAL TABLE IF NOT EXISTS texts_loose USING fts5(
  loose, content='', contentless_delete=1, tokenize='trigram case_sensitive 1'
);
`;
