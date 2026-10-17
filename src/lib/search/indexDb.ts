import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export class IndexUnavailableError extends Error {}

let cached: { file: string; inode: number; db: Database.Database } | null = null;

/**
 * Where the index lives. Read from the environment on every request, like
 * the chat route's LM Studio settings, so changing it needs no rebuild.
 */
export function indexPath(): string {
  // turbopackIgnore: this path is only known at runtime. Without the hint,
  // Next's file tracer can't tell what it points at, traces the whole project
  // and copies data/ — client PDFs included — into the server bundle.
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.SEARCH_INDEX_PATH ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data/index/search.db")
  );
}

/**
 * A read-only connection to the index, opened once and reused.
 *
 * Read-only is enforced by SQLite itself, not by convention: this
 * connection cannot change the index even if a bug tried to.
 *
 * Incremental indexing updates the file in place and SQLite shows each
 * committed change to this connection automatically. A forced rebuild
 * swaps in a new file instead; the inode check notices that and reopens.
 */
export function getIndexDb(): Database.Database {
  const file = indexPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(/*turbopackIgnore: true*/ file);
  } catch {
    // The path goes to the server log only: it describes the server's disk,
    // which a browser has no business seeing.
    console.error(`[search] no index at ${file}`);
    throw new IndexUnavailableError(
      "The search index hasn't been built yet. Build it with `npm run index`, or set SEARCH_INDEX_PATH."
    );
  }

  if (cached && cached.file === file && cached.inode === stat.ino) return cached.db;

  cached?.db.close();
  const db = new Database(/*turbopackIgnore: true*/ file, { readonly: true, fileMustExist: true });
  // If the indexer is mid-write, wait briefly instead of failing the search.
  db.pragma("busy_timeout = 2000");
  cached = { file, inode: stat.ino, db };
  return db;
}
