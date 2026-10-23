/**
 * npm run verify:library [-- --documents 500] [--queries 1000]
 *
 * Brute-force check of the library index on LOCUS_DATA_DIR (see
 * src/lib/library/verify.ts): for a random subset of documents, the pages
 * the full-text index returns must equal, exactly, the pages a plain
 * substring scan of their text finds. Exits 1 on any difference, or if the
 * index and its full-text tables disagree on how many rows there are.
 * Read-only.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { loadEnvConfig } from "@next/env";
import { libraryPaths, loadLibraryConfig } from "../src/lib/library/config";
import { checkDataDir } from "../src/lib/library/storage/volume";
import { verifyLibrary } from "../src/lib/library/verify";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const config = loadLibraryConfig();
  // An explicit file (e.g. a test or benchmark index) skips the drive check.
  const file = process.env.LIBRARY_INDEX_FILE ?? (config.dataDir ? libraryPaths(config.dataDir).db : null);
  if (!process.env.LIBRARY_INDEX_FILE) {
    const verdict = await checkDataDir(config.dataDir, { allowExfat: true });
    if (!verdict.ok) {
      console.error(`[verify:library] ${verdict.message}`);
      process.exit(1);
    }
  }
  if (!file || !fs.existsSync(file)) {
    console.error(`[verify:library] No library index at ${file}. Run npm run index:library first.`);
    process.exit(1);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const started = Date.now();
  const r = verifyLibrary(db, { documents: arg("--documents", 500), queries: arg("--queries", 1000) });
  db.close();
  console.log(`index: ${file}`);
  console.log(`stored texts: ${r.rowCounts.texts}, exact-index rows: ${r.rowCounts.exact}, loose-index rows: ${r.rowCounts.loose}`);
  console.log(
    `checked ${r.documents} documents (${r.texts} texts), ${r.queries} queries, ${r.comparisons} comparisons across exact+loose, ${((Date.now() - started) / 1000).toFixed(1)} s`
  );
  console.log(`disagreements: ${r.disagreements.length}`);
  for (const d of r.disagreements.slice(0, 20)) console.log(JSON.stringify(d));
  if (r.disagreements.length > 0 || r.rowCounts.texts !== r.rowCounts.exact || r.rowCounts.texts !== r.rowCounts.loose) process.exit(1);
}

main();
