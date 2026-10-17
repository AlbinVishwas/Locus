import type Database from "better-sqlite3";
import { foldCase, loosen, type SearchMode } from "../../src/lib/search/normalize";
import { prepareQuery, search } from "../../src/lib/search/query";

/**
 * Ground truth by brute force: which (document, page) pairs contain the
 * query, found by reading every stored page body and calling
 * String.includes — no SQL matching, no full-text index. If the index ever
 * disagrees with this, the index is wrong.
 *
 * It re-derives the comparable text from `body` rather than trusting the
 * stored `search`/`loose` columns, so a bug in what the indexer stored would
 * show up as a difference too.
 */
export interface Corpus {
  pages: Array<{ key: string; filename: string; exact: string; loose: string }>;
  filenames: Array<{ filename: string; exact: string; loose: string }>;
}

export function loadCorpus(db: Database.Database): Corpus {
  const rows = db
    .prepare(
      `SELECT d.filename, p.page_no AS pageNo, t.body
       FROM texts t JOIN pages p ON p.id = t.page_id JOIN documents d ON d.id = p.doc_id`
    )
    .all() as Array<{ filename: string; pageNo: number; body: string }>;
  const docs = db.prepare("SELECT filename FROM documents").pluck().all() as string[];
  return {
    pages: rows.map((r) => {
      const exact = foldCase(r.body);
      return { key: `${r.filename}#${r.pageNo}`, filename: r.filename, exact, loose: loosen(exact) };
    }),
    filenames: docs.map((filename) => {
      // Same path the indexer takes: normalize, then fold, then loosen.
      const exact = prepareQuery(filename, "exact");
      return { filename, exact, loose: loosen(exact) };
    }),
  };
}

export function bruteForce(corpus: Corpus, query: string, mode: SearchMode) {
  const q = prepareQuery(query, mode);
  const pages = new Set<string>();
  const filenames = new Set<string>();
  if (q === "") return { pages, filenames };
  for (const p of corpus.pages) if (p[mode].includes(q)) pages.add(p.key);
  for (const f of corpus.filenames) if (f[mode].includes(q)) filenames.add(f.filename);
  return { pages, filenames };
}

/** Everything search() returns for a query, with pagination unrolled. */
export function viaIndex(db: Database.Database, query: string, mode: SearchMode) {
  const result = search(db, query, { mode, offset: 0, limit: Number.MAX_SAFE_INTEGER });
  return {
    result,
    pages: new Set(result.hits.map((h) => `${h.filename}#${h.pageNo}`)),
    filenames: new Set(result.documents.filter((d) => d.filenameMatch).map((d) => d.filename)),
  };
}

export interface Disagreement {
  query: string;
  mode: SearchMode;
  onlyInIndex: string[];
  onlyInBruteForce: string[];
}

/** Compares index and brute force for one query; null when they agree exactly. */
export function compare(
  db: Database.Database,
  corpus: Corpus,
  query: string,
  mode: SearchMode
): Disagreement | null {
  const truth = bruteForce(corpus, query, mode);
  const got = viaIndex(db, query, mode);
  const onlyInIndex = [
    ...[...got.pages].filter((k) => !truth.pages.has(k)),
    ...[...got.filenames].filter((f) => !truth.filenames.has(f)).map((f) => `filename:${f}`),
  ];
  const onlyInBruteForce = [
    ...[...truth.pages].filter((k) => !got.pages.has(k)),
    ...[...truth.filenames].filter((f) => !got.filenames.has(f)).map((f) => `filename:${f}`),
  ];
  // Counts must agree with the hit list, too.
  if (got.result.totalPages !== got.pages.size) onlyInIndex.push(`totalPages=${got.result.totalPages}`);
  return onlyInIndex.length || onlyInBruteForce.length
    ? { query, mode, onlyInIndex, onlyInBruteForce }
    : null;
}

/** Deterministic pseudo-random numbers, so a failing test can be re-run exactly. */
export function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Queries drawn from the corpus itself — random slices of real page text, of
 * random length, in random case — plus slices that straddle words. Drawing
 * from the text guarantees most queries have hits, which is where a bug
 * could hide; the fixed lists in the tests cover the misses.
 */
export function sampleQueries(corpus: Corpus, count: number, seed: number): string[] {
  const rand = seededRandom(seed);
  const queries: string[] = [];
  const withText = corpus.pages.filter((p) => p.exact.length > 0);
  for (let i = 0; i < count && withText.length > 0; i++) {
    const page = withText[Math.floor(rand() * withText.length)].exact;
    const len = 1 + Math.floor(rand() * Math.min(40, page.length));
    const start = Math.floor(rand() * Math.max(1, page.length - len));
    let q = page.slice(start, start + len);
    if (rand() < 0.3) q = q.toUpperCase();
    if (rand() < 0.2) q = q.replace(/ /g, "\n");
    if (q.trim() !== "") queries.push(q);
  }
  return queries;
}
