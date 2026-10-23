import type Database from "better-sqlite3";
import type { SearchMode } from "../search/normalize";
import { codePointLength, foldCase, loosen } from "../search/normalize";
import { prepareQuery, toFtsPhrase } from "../search/query";
import { mulberry32 } from "./pipeline";
import { libraryTextIdRange } from "./schema";

/**
 * Brute-force check of the library index, the verify:index idea scaled for
 * a library too big to hold in memory: pick a random subset of documents,
 * load just their text, and for many queries compare what the full-text
 * index returns *within those documents' id ranges* against a plain
 * substring scan of the same text. Any difference is a bug in how the
 * library writes its index.
 */

export interface VerifyResult {
  documents: number;
  texts: number;
  queries: number;
  comparisons: number;
  disagreements: Array<{ query: string; mode: SearchMode; onlyIndex: number[]; onlyScan: number[] }>;
  rowCounts: { texts: number; exact: number; loose: number };
}

export function verifyLibrary(db: Database.Database, options: { documents?: number; queries?: number; seed?: number } = {}): VerifyResult {
  const rng = mulberry32(options.seed ?? 20261023);
  const allDocs = db.prepare("SELECT id FROM documents WHERE status = 'ready' ORDER BY id").pluck().all() as number[];
  const want = Math.min(options.documents ?? 500, allDocs.length);
  // Partial Fisher-Yates: a uniform subset without shuffling the whole list.
  for (let i = 0; i < want; i++) {
    const j = i + Math.floor(rng() * (allDocs.length - i));
    [allDocs[i], allDocs[j]] = [allDocs[j], allDocs[i]];
  }
  const docs = allDocs.slice(0, want).sort((a, b) => a - b);

  const textsOf = db.prepare("SELECT id, body FROM texts WHERE id BETWEEN ? AND ? ORDER BY id");
  const corpus: Array<{ id: number; exact: string; loose: string }> = [];
  for (const d of docs) {
    const [lo, hi] = libraryTextIdRange(d);
    for (const row of textsOf.all(lo, hi) as Array<{ id: number; body: string }>) {
      const exact = foldCase(row.body);
      corpus.push({ id: row.id, exact, loose: loosen(exact) });
    }
  }

  const fixed = ["earnest money", "bank guarantee", "tender", "26-2080", "26/2080", "Rs.", "₹", '"', "AND", "NEAR(", "' OR 1=1 --", "zzzz-not-present", "निविदा"];
  const sampled: string[] = [];
  const nQueries = options.queries ?? 1000;
  for (let i = 0; i < nQueries && corpus.length > 0; i++) {
    const t = corpus[Math.floor(rng() * corpus.length)].exact;
    if (t.length < 3) continue;
    const len = 3 + Math.floor(rng() * 20);
    const start = Math.floor(rng() * Math.max(1, t.length - len));
    sampled.push(t.slice(start, start + len));
  }
  const queries = [...fixed, ...sampled];

  const match = {
    exact: db.prepare("SELECT rowid FROM texts_exact WHERE texts_exact MATCH ? AND rowid BETWEEN ? AND ?").pluck(),
    loose: db.prepare("SELECT rowid FROM texts_loose WHERE texts_loose MATCH ? AND rowid BETWEEN ? AND ?").pluck(),
  };

  const disagreements: VerifyResult["disagreements"] = [];
  let comparisons = 0;
  for (const q of queries) {
    for (const mode of ["exact", "loose"] as const) {
      const prepared = prepareQuery(q, mode);
      // The library needs 3+ characters (the trigram index can't look up less).
      if (prepared === "" || codePointLength(prepared) < 3) continue;
      comparisons++;
      const fromIndex = new Set<number>();
      for (const d of docs) {
        const [lo, hi] = libraryTextIdRange(d);
        for (const id of match[mode].all(toFtsPhrase(prepared), lo, hi) as number[]) fromIndex.add(id);
      }
      const fromScan = new Set(corpus.filter((t) => t[mode].includes(prepared)).map((t) => t.id));
      const onlyIndex = [...fromIndex].filter((id) => !fromScan.has(id));
      const onlyScan = [...fromScan].filter((id) => !fromIndex.has(id));
      if (onlyIndex.length || onlyScan.length) disagreements.push({ query: q, mode, onlyIndex: onlyIndex.slice(0, 5), onlyScan: onlyScan.slice(0, 5) });
    }
  }

  const count = (sql: string) => Number(db.prepare(sql).pluck().get());
  return {
    documents: docs.length,
    texts: corpus.length,
    queries: queries.length,
    comparisons,
    disagreements,
    rowCounts: {
      texts: count("SELECT count(*) FROM texts"),
      exact: count("SELECT count(*) FROM texts_exact_docsize"),
      loose: count("SELECT count(*) FROM texts_loose_docsize"),
    },
  };
}
