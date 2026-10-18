import type Database from "better-sqlite3";
import {
  codePointLength,
  foldCase,
  loosen,
  normalizeText,
  type SearchMode,
} from "./normalize";
import { buildSnippet, type SnippetPart } from "./snippet";
import { splitTextId, textId, type PageSource, type TextKind } from "./schema";

/**
 * Searching the index. Deterministic by construction: a page is a hit if and
 * only if its stored text contains the query (after normalize.ts), and the
 * page numbers come straight from the rows the indexer wrote. No model, no
 * ranking guesswork.
 */

/** The trigram index needs at least 3 characters to look anything up. */
export const MIN_INDEXED_QUERY_CHARS = 3;

export interface SearchOptions {
  mode: SearchMode;
  /** Pagination over hits (pages), ordered by filename then page number. */
  offset: number;
  limit: number;
  /**
   * Which documents are in scope: `null` is the standalone tender corpus
   * (conversation_id IS NULL in the index), a string is one chat
   * conversation's uploads. Omitted entirely means "every document,
   * regardless of scope" — only ever used by tests and the brute-force
   * oracle, which intentionally don't care about scoping.
   */
  scope?: string | null;
}

export interface DocumentSummary {
  docId: number;
  filename: string;
  /** Pages in this document whose text contains the query. */
  hitCount: number;
  /** True when the filename itself contains the query. */
  filenameMatch: boolean;
}

export interface PageHit {
  docId: number;
  filename: string;
  pageNo: number;
  /** Printed label from the PDF (e.g. "iv", "A-3"), when the PDF defines one. */
  pageLabel: string | null;
  source: PageSource;
  /** Which stored readings of the page contain the query. */
  matchedIn: TextKind[];
  /** True when only the OCR reading matched: worth double-checking by eye. */
  ocrOnly: boolean;
  snippet: SnippetPart[];
}

export interface SearchResult {
  query: string;
  mode: SearchMode;
  /** The query as compared, after normalization (and loosening). */
  prepared: string;
  /**
   * Under 3 characters the index can't help, so every page's text is scanned.
   * Still exact and complete, just slower on a large collection.
   */
  usedFullScan: boolean;
  totalPages: number;
  totalDocuments: number;
  /** Every document with a page hit or a filename match — never truncated. */
  documents: DocumentSummary[];
  /** One window of page hits; `offset`/`limit` page through the rest. */
  hits: PageHit[];
  offset: number;
  limit: number;
  hasMore: boolean;
  tookMs: number;
}

/** The query in the exact form the stored text is compared against. */
export function prepareQuery(raw: string, mode: SearchMode): string {
  const folded = foldCase(normalizeText(raw));
  return mode === "exact" ? folded : loosen(folded);
}

/**
 * Wraps the user's text as one FTS5 phrase string. Inside double quotes,
 * FTS5 treats everything as literal text — AND, OR, NOT, NEAR, *, ^, column
 * filters, brackets — and a literal quote is written as two quotes. So no
 * input can change the shape of the query, only what it looks for. The
 * phrase is still passed as a bound parameter, never spliced into SQL.
 */
export function toFtsPhrase(prepared: string): string {
  return `"${prepared.replaceAll('"', '""')}"`;
}

// Column and table names come from this fixed table, never from input.
//
// Only text-row ids come back from a match. A text row's id encodes its page
// and which reading it is (see textId in schema.ts), so no join is needed to
// know what matched: at 100k pages, joining every hit to its page row was
// most of the time spent on a query matching many pages. ORDER BY rowid is
// free here (both the index and the table are stored in rowid order) and
// guarantees the order the grouping below relies on.
const SQL_BY_MODE = {
  exact: {
    indexed: "SELECT rowid FROM texts_exact WHERE texts_exact MATCH ? ORDER BY rowid",
    scan: "SELECT id FROM texts WHERE instr(search, ?) > 0 ORDER BY id",
    filename: "SELECT id FROM documents WHERE instr(filename_search, ?) > 0",
  },
  loose: {
    indexed: "SELECT rowid FROM texts_loose WHERE texts_loose MATCH ? ORDER BY rowid",
    scan: "SELECT id FROM texts WHERE instr(loose, ?) > 0 ORDER BY id",
    filename: "SELECT id FROM documents WHERE instr(filename_loose, ?) > 0",
  },
} as const;

interface Statements {
  indexed: Record<SearchMode, Database.Statement>;
  scan: Record<SearchMode, Database.Statement>;
  filename: Record<SearchMode, Database.Statement>;
  generation: Database.Statement;
  documents: Database.Statement;
  pages: Database.Statement;
  page: Database.Statement;
  texts: Database.Statement;
}

/**
 * Which document each page belongs to and its page number, held in memory as
 * two flat arrays indexed by page id, plus each document's filename and its
 * position in filename order. A few bytes per page: about 1 MB at 100k pages.
 *
 * Reloaded whenever the index's generation counter changes, which the
 * indexer bumps in every write transaction, so it can never describe an
 * older index than the one being searched.
 */
interface PageMap {
  generation: string;
  pageDoc: Int32Array;
  pageNo: Int32Array;
  filename: Map<number, string>;
  rank: Map<number, number>;
  /** docId -> its conversation scope (null = tender corpus). */
  scope: Map<number, string | null>;
}

interface Cache {
  statements: Statements;
  pageMap: PageMap | null;
}

// Preparing a statement parses the SQL; doing that once per connection
// rather than once per search keeps small queries well under a millisecond.
const cache = new WeakMap<Database.Database, Cache>();

function connectionCache(db: Database.Database): Cache {
  let c = cache.get(db);
  if (!c) {
    const byMode = (key: "indexed" | "scan" | "filename") => ({
      exact: db.prepare(SQL_BY_MODE.exact[key]).pluck(),
      loose: db.prepare(SQL_BY_MODE.loose[key]).pluck(),
    });
    c = {
      statements: {
        indexed: byMode("indexed"),
        scan: byMode("scan"),
        filename: byMode("filename"),
        generation: db.prepare("SELECT value FROM meta WHERE key = 'generation'").pluck(),
        documents: db.prepare(
          "SELECT id, filename, original_filename as originalFilename, conversation_id as conversationId FROM documents"
        ),
        pages: db.prepare("SELECT id, doc_id, page_no FROM pages").raw(),
        page: db.prepare("SELECT page_label, source FROM pages WHERE id = ?"),
        texts: db.prepare("SELECT id, body FROM texts WHERE id BETWEEN ? AND ?"),
      },
      pageMap: null,
    };
    cache.set(db, c);
  }
  return c;
}

function pageMap(c: Cache): PageMap {
  const s = c.statements;
  const generation = String(s.generation.get() ?? "");
  if (c.pageMap && c.pageMap.generation === generation) return c.pageMap;

  const rows = s.pages.all() as Array<[id: number, docId: number, pageNo: number]>;
  const maxId = rows.reduce((m, [id]) => Math.max(m, id), 0);
  const pageDoc = new Int32Array(maxId + 1);
  const pageNo = new Int32Array(maxId + 1);
  for (const [id, docId, no] of rows) {
    pageDoc[id] = docId;
    pageNo[id] = no;
  }

  const docs = s.documents.all() as Array<{
    id: number;
    filename: string;
    originalFilename: string | null;
    conversationId: string | null;
  }>;
  // The tender corpus has no original_filename (its own filename already
  // is the display name); an upload's filename on disk is content-
  // addressed and meaningless to show -- original_filename is what the
  // user actually called it.
  const display = (d: { filename: string; originalFilename: string | null }) =>
    d.originalFilename ?? d.filename;
  docs.sort((a, b) => {
    const da = display(a);
    const db_ = display(b);
    return da < db_ ? -1 : da > db_ ? 1 : a.id - b.id;
  });
  c.pageMap = {
    generation,
    pageDoc,
    pageNo,
    filename: new Map(docs.map((d) => [d.id, display(d)])),
    rank: new Map(docs.map((d, i) => [d.id, i])),
    scope: new Map(docs.map((d) => [d.id, d.conversationId])),
  };
  return c.pageMap;
}

// Bit flags for which readings of a page matched.
const LAYER = 1;
const OCR = 2;

/** Whether a conversation has any uploaded documents at all -- the gate chat uses to decide whether to search its files for a turn, or skip that entirely. */
export function hasDocumentsForConversation(db: Database.Database, conversationId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM documents WHERE conversation_id = ? LIMIT 1")
      .pluck()
      .get(conversationId) !== undefined
  );
}

export function search(
  db: Database.Database,
  rawQuery: string,
  options: SearchOptions
): SearchResult {
  const started = performance.now();
  const { mode, offset, limit } = options;
  // `scope` absent (not even `null`) means "don't filter at all" -- only
  // the oracle and a couple of tests want that; every real caller passes
  // either a conversation id or `null` for the tender corpus.
  const scoped = "scope" in options;
  const scope = options.scope ?? null;
  const prepared = prepareQuery(rawQuery, mode);
  const usedFullScan = codePointLength(prepared) < MIN_INDEXED_QUERY_CHARS;
  const c = connectionCache(db);
  const s = c.statements;
  const map = pageMap(c);
  const inScope = (docId: number) => !scoped || map.scope.get(docId) === scope;

  // An empty prepared query (e.g. "///" in loose mode) can't match anything
  // meaningful; instr() with "" would match every page, so stop here.
  const textIds = (
    prepared === ""
      ? []
      : usedFullScan
        ? s.scan[mode].all(prepared)
        : s.indexed[mode].all(toFtsPhrase(prepared))
  ) as number[];

  // Group matched text rows into pages, and pages into documents. Ids arrive
  // in ascending order, so a page's two readings are adjacent and each
  // document's pages come out in page order.
  const pagesByDoc = new Map<number, Array<{ pageId: number; readings: number }>>();
  let last: { pageId: number; readings: number } | null = null;
  let totalPages = 0;
  for (const id of textIds) {
    const { pageId, kind } = splitTextId(id);
    const reading = kind === "ocr" ? OCR : LAYER;
    if (last && last.pageId === pageId) {
      last.readings |= reading;
      continue;
    }
    last = { pageId, readings: reading };
    const docId = map.pageDoc[pageId];
    if (!inScope(docId)) continue;
    let list = pagesByDoc.get(docId);
    if (!list) pagesByDoc.set(docId, (list = []));
    list.push(last);
    totalPages++;
  }

  const filenameIds = new Set<number>(
    prepared === ""
      ? []
      : (s.filename[mode].all(prepared) as number[]).filter(inScope)
  );

  const docOrder = [...new Set([...pagesByDoc.keys(), ...filenameIds])].sort(
    (a, b) => map.rank.get(a)! - map.rank.get(b)!
  );

  const documents: DocumentSummary[] = docOrder.map((docId) => ({
    docId,
    filename: map.filename.get(docId)!,
    hitCount: pagesByDoc.get(docId)?.length ?? 0,
    filenameMatch: filenameIds.has(docId),
  }));

  // Walk documents in filename order and take only the requested window of
  // hits; pages outside it are counted above but never loaded.
  const window: Array<{ docId: number; pageId: number; readings: number }> = [];
  let skipped = 0;
  for (const docId of docOrder) {
    const list = pagesByDoc.get(docId);
    if (!list) continue;
    if (skipped + list.length <= offset) {
      skipped += list.length;
      continue;
    }
    for (let i = Math.max(0, offset - skipped); i < list.length && window.length < limit; i++) {
      window.push({ docId, ...list[i] });
    }
    skipped += list.length;
    if (window.length >= limit) break;
  }

  const hits: PageHit[] = window.map(({ docId, pageId, readings }) => {
    const page = s.page.get(pageId) as { page_label: string | null; source: PageSource };
    const texts = s.texts.all(textId(pageId, "layer"), textId(pageId, "ocr")) as Array<{
      id: number;
      body: string;
    }>;
    const matchedIn: TextKind[] = [];
    if (readings & LAYER) matchedIn.push("layer");
    if (readings & OCR) matchedIn.push("ocr");
    // Prefer the text layer for the snippet: it is what the PDF actually
    // says, where OCR is a reading of it.
    const snippetSource = texts.find((t) => t.id === textId(pageId, matchedIn[0]))!;
    return {
      docId,
      filename: map.filename.get(docId)!,
      pageNo: map.pageNo[pageId],
      pageLabel: page.page_label,
      source: page.source,
      matchedIn,
      ocrOnly: readings === OCR,
      snippet: buildSnippet(snippetSource.body, prepared, mode),
    };
  });

  return {
    query: rawQuery,
    mode,
    prepared,
    usedFullScan,
    totalPages,
    totalDocuments: pagesByDoc.size,
    documents,
    hits,
    offset,
    limit,
    hasMore: offset + hits.length < totalPages,
    tookMs: performance.now() - started,
  };
}
