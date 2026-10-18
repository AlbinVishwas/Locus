import { loadConfig } from "../../../scripts/indexer/config";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import { deleteDocument, expiredDocuments, sha256StillReferenced } from "../../../scripts/indexer/store";
import { deleteStoredFile } from "./storage";
import { getWritableDb } from "./writableDb";

/**
 * Deletes every document past its retention expiry, along with its file
 * and OCR cache entries once nothing else references that content. The
 * tender corpus is never touched: its documents have no expiry at all
 * (expires_at IS NULL), which is exactly what expiredDocuments excludes.
 *
 * Runs at server start and hourly after that (see register() below), so an
 * expiry missed while the laptop was asleep or off is handled on the next
 * run rather than drifting forever.
 */
export async function runRetentionCleanup(log: (message: string) => void = () => {}): Promise<{
  deletedDocuments: number;
  deletedFiles: number;
}> {
  const db = getWritableDb();
  const expired = expiredDocuments(db, new Date().toISOString());
  if (expired.length === 0) return { deletedDocuments: 0, deletedFiles: 0 };

  log(`[cleanup] ${expired.length} expired document(s)`);
  const config = loadConfig();
  const ocrCache = new OcrCache(config.ocrCachePath);
  let deletedFiles = 0;

  try {
    for (const doc of expired) {
      db.transaction(() => deleteDocument(db, doc.id))();
      if (!sha256StillReferenced(db, doc.sha256, doc.id)) {
        await deleteStoredFile(doc.sha256);
        ocrCache.deleteForFile(doc.sha256);
        deletedFiles++;
      }
    }
  } finally {
    ocrCache.close();
  }

  // Incremental, not a full VACUUM: reclaims the pages the deletes just
  // freed in small batches without the long exclusive lock a full VACUUM
  // takes (it rewrites the entire file) -- a live search shouldn't have to
  // wait for that just because an hourly cleanup ran.
  db.pragma("incremental_vacuum");

  log(`[cleanup] removed ${expired.length} document(s), ${deletedFiles} file(s)`);
  return { deletedDocuments: expired.length, deletedFiles };
}

let scheduled = false;

/** Starts the hourly cleanup schedule. Idempotent: a second call is a no-op, so re-importing this module (hot reload, multiple route modules) never starts two timers. */
export function startRetentionSchedule(): void {
  if (scheduled) return;
  scheduled = true;

  const hourMs = 60 * 60 * 1000;
  const run = () => {
    runRetentionCleanup((m) => console.log(m)).catch((err) => {
      console.error("[cleanup] retention cleanup failed", err);
    });
  };
  run();
  setInterval(run, hourMs);
}
