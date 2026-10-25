import type Database from "better-sqlite3";
import { codePointLength, type SearchMode } from "../search/normalize";
import { prepareQuery, toFtsPhrase } from "../search/query";
import type { PageSource, TextKind } from "../search/schema";
import { buildSnippet, type SnippetPart } from "../search/snippet";

/**
 * Searching the library index. Same matching as session search -- the
 * text is normalized the same way and the full-text tables are configured
 * the same way, so a page is a hit if and only if its text contains the
 * query -- but shaped for millions of pages:
 *
 *  - Hits come back one window at a time, by cursor. A text row's id
 *    encodes document, page and reading (schema.ts), and rowid order is
 *    document order then page order, so "the next 50 pages" is
 *    `rowid > cursor ... LIMIT`, never "collect every hit, then slice".
 *    No page table is held in memory.
 *  - Counts (pages, documents) are taken by walking the match list once,
 *    within a time budget. Past it, the counts are reported as "at least"
 *    so a very common word can't hold a search up.
 *  - Under 3 characters the trigram index can't look anything up, and a
 *    full scan of millions of pages takes too long: the query is refused
 *    with a clear message instead (session search is unchanged).
 */

export const LIBRARY_PAGE_LIMIT = 50;
export const LIBRARY_MIN_QUERY_CHARS = 3;
export const DEFAULT_COUNT_BUDGET_MS = 300;

export interface LibraryHit {
  docId: number;
  /** Folder-relative path, or "db:<id> · <filename>". Never an absolute path. */
  displayName: string;
  /** True while the document is still being indexed: more of its pages may match later. */
  stillIndexing: boolean;
  pageNo: number;
  pageLabel: string | null;
  source: PageSource;
  matchedIn: TextKind[];
  ocrOnly: boolean;
  snippet: SnippetPart[];
}

export interface LibraryCounts {
  pages: number;
  documents: number;
  /** False when counting stopped at the time budget: the true numbers are at least these. */
  complete: boolean;
}

export interface LibrarySearchResult {
  query: string;
  mode: SearchMode;
  prepared: string;
  hits: LibraryHit[];
  /** Pass back to get the next window; null when there are no more hits. */
  nextCursor: number | null;
  /** Only on the first window (cursor 0); a "show more" request doesn't recount. */
  counts: LibraryCounts | null;
  /** On a first window with no exact hits: how many pages match ignoring punctuation (null if not applicable). */
  looseCount: number | null;
  limit: number;
  tookMs: number;
}

export type LibrarySearchOutcome = { status: "ok"; result: LibrarySearchResult } | { status: "too-short"; query: string };

const MATCH_SQL = {
  exact: {
    window: "SELECT rowid FROM texts_exact WHERE texts_exact MATCH ? AND rowid > ? ORDER BY rowid LIMIT ?",
    all: "SELECT rowid FROM texts_exact WHERE texts_exact MATCH ? ORDER BY rowid",
  },
  loose: {
    window: "SELECT rowid FROM texts_loose WHERE texts_loose MATCH ? AND rowid > ? ORDER BY rowid LIMIT ?",
    all: "SELECT rowid FROM texts_loose WHERE texts_loose MATCH ? ORDER BY rowid",
  },
} as const;

// A text id is docId * 2^21 + pageNo * 2 + kind (schema.ts): halving gives one key per page.
const PAGE_KEY_DIVISOR = 2;
const DOC_DIVISOR = 2 ** 21;

const statements = new WeakMap<Database.Database, Record<string, Database.Statement>>();

function stmts(db: Database.Database) {
  let s = statements.get(db);
  if (!s) {
    s = {
      exactWindow: db.prepare(MATCH_SQL.exact.window).pluck(),
      looseWindow: db.prepare(MATCH_SQL.loose.window).pluck(),
      exactAll: db.prepare(MATCH_SQL.exact.all).pluck(),
      looseAll: db.prepare(MATCH_SQL.loose.all).pluck(),
      doc: db.prepare("SELECT display_name AS displayName, status FROM documents WHERE id = ?"),
      page: db.prepare("SELECT page_label AS pageLabel, source FROM pages WHERE doc_id = ? AND page_no = ?"),
      text: db.prepare("SELECT body FROM texts WHERE id = ?").pluck(),
    };
    statements.set(db, s);
  }
  return s;
}

/** Walks the match list counting distinct pages and documents, until done or out of time. */
export function countMatches(db: Database.Database, phrase: string, mode: SearchMode, budgetMs: number): LibraryCounts {
  const started = performance.now();
  const s = stmts(db);
  let pages = 0;
  let documents = 0;
  let lastPage = -1;
  let lastDoc = -1;
  let n = 0;
  for (const id of (mode === "exact" ? s.exactAll : s.looseAll).iterate(phrase) as IterableIterator<number>) {
    const pageKey = Math.floor(id / PAGE_KEY_DIVISOR);
    if (pageKey !== lastPage) {
      pages++;
      lastPage = pageKey;
      const doc = Math.floor(id / DOC_DIVISOR);
      if (doc !== lastDoc) {
        documents++;
        lastDoc = doc;
      }
    }
    if (++n % 1024 === 0 && performance.now() - started > budgetMs) {
      return { pages, documents, complete: false };
    }
  }
  return { pages, documents, complete: true };
}

export function librarySearch(
  db: Database.Database,
  rawQuery: string,
  options: { mode: SearchMode; cursor?: number; limit?: number; countBudgetMs?: number }
): LibrarySearchOutcome {
  const started = performance.now();
  const { mode } = options;
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? LIBRARY_PAGE_LIMIT;
  const prepared = prepareQuery(rawQuery, mode);
  if (prepared !== "" && codePointLength(prepared) < LIBRARY_MIN_QUERY_CHARS) {
    return { status: "too-short", query: rawQuery };
  }
  const empty = (): LibrarySearchOutcome => ({
    status: "ok",
    result: { query: rawQuery, mode, prepared, hits: [], nextCursor: null, counts: cursor === 0 ? { pages: 0, documents: 0, complete: true } : null, looseCount: null, limit, tookMs: performance.now() - started },
  });
  if (prepared === "") return empty();

  const s = stmts(db);
  const phrase = toFtsPhrase(prepared);
  // Up to two readings per page: 2 * limit + 2 rows always reach limit + 1
  // pages when that many exist, which says whether there's a next window.
  const rows = (mode === "exact" ? s.exactWindow : s.looseWindow).all(phrase, cursor, limit * 2 + 2) as number[];
  const pages: Array<{ key: number; ids: number[] }> = [];
  for (const id of rows) {
    const key = Math.floor(id / PAGE_KEY_DIVISOR);
    const last = pages[pages.length - 1];
    if (last && last.key === key) last.ids.push(id);
    else pages.push({ key, ids: [id] });
  }
  const more = pages.length > limit;
  const windowPages = pages.slice(0, limit);

  const docCache = new Map<number, { displayName: string; status: string } | undefined>();
  const hits: LibraryHit[] = windowPages.map(({ key, ids }) => {
    const docId = Math.floor(key / (DOC_DIVISOR / PAGE_KEY_DIVISOR));
    const pageNo = key - docId * (DOC_DIVISOR / PAGE_KEY_DIVISOR);
    if (!docCache.has(docId)) docCache.set(docId, s.doc.get(docId) as { displayName: string; status: string } | undefined);
    const doc = docCache.get(docId);
    const page = s.page.get(docId, pageNo) as { pageLabel: string | null; source: PageSource } | undefined;
    const matchedIn: TextKind[] = ids.map((id) => (id % 2 === 1 ? "ocr" : "layer"));
    // Prefer the text layer for the snippet: it's what the PDF says; OCR is a reading of it.
    const snippetId = ids[0];
    const body = (s.text.get(snippetId) as string | undefined) ?? "";
    return {
      docId,
      displayName: doc?.displayName ?? `document ${docId}`,
      stillIndexing: doc?.status === "indexing",
      pageNo,
      pageLabel: page?.pageLabel ?? null,
      source: page?.source ?? "text",
      matchedIn,
      ocrOnly: matchedIn.length === 1 && matchedIn[0] === "ocr",
      snippet: buildSnippet(body, prepared, mode),
    };
  });

  const counts = cursor === 0 ? countMatches(db, phrase, mode, options.countBudgetMs ?? DEFAULT_COUNT_BUDGET_MS) : null;
  let looseCount: number | null = null;
  if (cursor === 0 && mode === "exact" && hits.length === 0) {
    const loosePrepared = prepareQuery(rawQuery, "loose");
    if (loosePrepared !== "" && codePointLength(loosePrepared) >= LIBRARY_MIN_QUERY_CHARS) {
      looseCount = countMatches(db, toFtsPhrase(loosePrepared), "loose", options.countBudgetMs ?? DEFAULT_COUNT_BUDGET_MS).pages;
    }
  }
  const lastId = windowPages.length > 0 ? windowPages[windowPages.length - 1].key * PAGE_KEY_DIVISOR + 1 : null;
  return {
    status: "ok",
    result: {
      query: rawQuery,
      mode,
      prepared,
      hits,
      nextCursor: more ? lastId : null,
      counts,
      looseCount,
      limit,
      tookMs: performance.now() - started,
    },
  };
}
