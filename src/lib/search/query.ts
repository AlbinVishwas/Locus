import type Database from "better-sqlite3";
import {
  codePointLength,
  foldCase,
  loosen,
  normalizeText,
  type SearchMode,
} from "./normalize";
import { buildSnippet, type SnippetPart } from "./snippet";
import type { PageSource, TextKind } from "./schema";

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
const SQL_BY_MODE = {
  exact: {
    indexed: `
      SELECT p.id, p.doc_id, p.page_no, t.kind
      FROM texts_exact f
      JOIN texts t ON t.id = f.rowid
      JOIN pages p ON p.id = t.page_id
      WHERE texts_exact MATCH ?`,
    scan: `
      SELECT p.id, p.doc_id, p.page_no, t.kind
      FROM texts t
      JOIN pages p ON p.id = t.page_id
      WHERE instr(t.search, ?) > 0`,
    filename: `SELECT id FROM documents WHERE instr(filename_search, ?) > 0`,
  },
  loose: {
    indexed: `
      SELECT p.id, p.doc_id, p.page_no, t.kind
      FROM texts_loose f
      JOIN texts t ON t.id = f.rowid
      JOIN pages p ON p.id = t.page_id
      WHERE texts_loose MATCH ?`,
    scan: `
      SELECT p.id, p.doc_id, p.page_no, t.kind
      FROM texts t
      JOIN pages p ON p.id = t.page_id
      WHERE instr(t.loose, ?) > 0`,
    filename: `SELECT id FROM documents WHERE instr(filename_loose, ?) > 0`,
  },
} as const;

interface Statements {
  indexed: Record<SearchMode, Database.Statement>;
  scan: Record<SearchMode, Database.Statement>;
  filename: Record<SearchMode, Database.Statement>;
  documents: Database.Statement;
  page: Database.Statement;
  texts: Database.Statement;
}

// Preparing a statement parses the SQL; doing that once per connection
// rather than once per search keeps small queries well under a millisecond.
const statementCache = new WeakMap<Database.Database, Statements>();

function statements(db: Database.Database): Statements {
  let s = statementCache.get(db);
  if (!s) {
    const byMode = (key: "indexed" | "scan" | "filename") => ({
      exact: db.prepare(SQL_BY_MODE.exact[key]).raw(),
      loose: db.prepare(SQL_BY_MODE.loose[key]).raw(),
    });
    s = {
      indexed: byMode("indexed"),
      scan: byMode("scan"),
      filename: byMode("filename"),
      documents: db.prepare("SELECT id, filename FROM documents"),
      page: db.prepare("SELECT page_label, source FROM pages WHERE id = ?"),
      texts: db.prepare("SELECT kind, body FROM texts WHERE page_id = ? ORDER BY kind"),
    };
    statementCache.set(db, s);
  }
  return s;
}

interface PageMatch {
  pageId: number;
  docId: number;
  pageNo: number;
  kinds: Set<TextKind>;
}

export function search(
  db: Database.Database,
  rawQuery: string,
  options: SearchOptions
): SearchResult {
  const started = performance.now();
  const { mode, offset, limit } = options;
  const prepared = prepareQuery(rawQuery, mode);
  const usedFullScan = codePointLength(prepared) < MIN_INDEXED_QUERY_CHARS;
  const s = statements(db);

  // An empty prepared query (e.g. "///" in loose mode) can't match anything
  // meaningful; instr() with "" would match every page, so stop here.
  const rows = (
    prepared === ""
      ? []
      : usedFullScan
        ? s.scan[mode].all(prepared)
        : s.indexed[mode].all(toFtsPhrase(prepared))
  ) as Array<[pageId: number, docId: number, pageNo: number, kind: TextKind]>;

  // A page can match through its text layer, its OCR text, or both; it is
  // one hit either way.
  const pages = new Map<number, PageMatch>();
  for (const [pageId, docId, pageNo, kind] of rows) {
    const existing = pages.get(pageId);
    if (existing) existing.kinds.add(kind);
    else pages.set(pageId, { pageId, docId, pageNo, kinds: new Set([kind]) });
  }

  const filenameIds = new Set<number>(
    prepared === "" ? [] : s.filename[mode].all(prepared).map((r) => (r as [number])[0])
  );

  const allDocs = s.documents.all() as Array<{ id: number; filename: string }>;
  const filenameOf = new Map(allDocs.map((d) => [d.id, d.filename]));

  const hitCounts = new Map<number, number>();
  for (const p of pages.values()) {
    hitCounts.set(p.docId, (hitCounts.get(p.docId) ?? 0) + 1);
  }

  const byFilename = (a: number, b: number) => {
    const fa = filenameOf.get(a)!;
    const fb = filenameOf.get(b)!;
    return fa < fb ? -1 : fa > fb ? 1 : a - b;
  };

  const documents: DocumentSummary[] = [...new Set([...hitCounts.keys(), ...filenameIds])]
    .sort(byFilename)
    .map((docId) => ({
      docId,
      filename: filenameOf.get(docId)!,
      hitCount: hitCounts.get(docId) ?? 0,
      filenameMatch: filenameIds.has(docId),
    }));

  const ordered = [...pages.values()].sort(
    (a, b) => byFilename(a.docId, b.docId) || a.pageNo - b.pageNo
  );

  const hits: PageHit[] = ordered.slice(offset, offset + limit).map((m) => {
    const page = s.page.get(m.pageId) as { page_label: string | null; source: PageSource };
    const texts = s.texts.all(m.pageId) as Array<{ kind: TextKind; body: string }>;
    const matchedIn = (["layer", "ocr"] as const).filter((k) => m.kinds.has(k));
    // Prefer the text layer for the snippet: it is what the PDF actually
    // says, where OCR is a reading of it.
    const snippetSource = texts.find((t) => t.kind === matchedIn[0])!;
    return {
      docId: m.docId,
      filename: filenameOf.get(m.docId)!,
      pageNo: m.pageNo,
      pageLabel: page.page_label,
      source: page.source,
      matchedIn: [...matchedIn],
      ocrOnly: matchedIn.length === 1 && matchedIn[0] === "ocr",
      snippet: buildSnippet(snippetSource.body, prepared, mode),
    };
  });

  return {
    query: rawQuery,
    mode,
    prepared,
    usedFullScan,
    totalPages: pages.size,
    totalDocuments: hitCounts.size,
    documents,
    hits,
    offset,
    limit,
    hasMore: offset + limit < ordered.length,
    tookMs: performance.now() - started,
  };
}
