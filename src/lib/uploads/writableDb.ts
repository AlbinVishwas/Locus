import type Database from "better-sqlite3";
// Reaching into scripts/indexer is deliberate: it's the one module that
// knows how to write the index, used by the CLI indexer, by tests, and now
// by this -- the one place the app itself writes rather than only reading
// (see the comment at the top of scripts/indexer/store.ts).
import { clearLegacyUploadExpiryOnce, openIndex } from "../../../scripts/indexer/store";
import { indexPath } from "../search/indexDb";

/**
 * A single writable connection to the index, opened once and kept open for
 * the life of the process. Unlike indexDb.ts's read-only connection (which
 * reopens if the file's inode changes, e.g. after a `--force` CLI rebuild),
 * this one is the uploads route's own -- there's exactly one writer, so
 * there's nothing to detect a change to.
 */
let cached: Database.Database | null = null;

export function getWritableDb(): Database.Database {
  if (!cached) {
    cached = openIndex(indexPath());
    clearLegacyUploadExpiryOnce(cached);
  }
  return cached;
}

/** Test-only: drops the cached connection so a test can point at a fresh file. */
export function _resetWritableDbForTests(): void {
  cached?.close();
  cached = null;
}
