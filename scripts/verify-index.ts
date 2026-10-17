/**
 * npm run verify:index [-- <count>]
 *
 * Brute-force check of the real index: for a large set of queries, the
 * (document, page) pairs the index returns must equal, exactly, the pairs a
 * naive scan of the stored page text finds. Any difference is printed and the
 * exit code is 1.
 *
 * Queries: <count> (default 2000) random slices of real page text in each
 * mode, plus a fixed list of tender-style terms, short queries and hostile
 * input. The vitest suite runs the same comparison on synthetic data; this
 * runs it on the actual collection, which isn't in the repository.
 */
import Database from "better-sqlite3";
import { loadConfig } from "./indexer/config";
import { compare, loadCorpus, sampleQueries, type Disagreement } from "./indexer/oracle";

const FIXED = [
  "26-2080", "26/2080", "26 2080", "earnest money", "EARNEST MONEY DEPOSIT", "EMD", "Rs", "Rs.",
  "GST", "BHEL", "a", "e", "1", "%", "₹", "bank guarantee", "performance security",
  "Haridwar", "tender no", "annexure", "pdf", "26033", "1759", '"', "AND", "NEAR(", "*",
  "' OR 1=1 --", "zzzz-not-present", "\u0000", "निविदा",
];

function main() {
  const count = Number(process.argv[2] ?? 2000);
  const config = loadConfig();
  const db = new Database(config.indexPath, { readonly: true, fileMustExist: true });
  const corpus = loadCorpus(db);

  const queries = [...FIXED, ...sampleQueries(corpus, count, 20261017)];
  const started = Date.now();
  const disagreements: Disagreement[] = [];
  let withHits = 0;
  let comparisons = 0;
  for (const q of queries) {
    for (const mode of ["exact", "loose"] as const) {
      comparisons++;
      const d = compare(db, corpus, q, mode);
      if (d) disagreements.push(d);
    }
    if (corpus.pages.some((p) => p.exact.includes(q.toLowerCase()))) withHits++;
  }

  const textRows = db.prepare("SELECT count(*) FROM texts").pluck().get();
  const exactRows = db.prepare("SELECT count(*) FROM texts_exact").pluck().get();
  const looseRows = db.prepare("SELECT count(*) FROM texts_loose").pluck().get();
  db.close();

  console.log(`index: ${config.indexPath}`);
  console.log(`stored texts: ${textRows}, exact-index rows: ${exactRows}, loose-index rows: ${looseRows}`);
  console.log(
    `queries: ${queries.length} (${FIXED.length} fixed + ${queries.length - FIXED.length} sampled), ` +
      `${comparisons} comparisons across exact+loose, ~${withHits} queries with hits, ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s`
  );
  console.log(`disagreements: ${disagreements.length}`);
  for (const d of disagreements.slice(0, 20)) console.log(JSON.stringify(d));

  if (disagreements.length > 0 || textRows !== exactRows || textRows !== looseRows) process.exit(1);
}

main();
