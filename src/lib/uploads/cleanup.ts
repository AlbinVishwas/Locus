import { loadConfig } from "../../../scripts/indexer/config";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import { deleteDocument, expiredDocuments, sha256StillReferenced } from "../../../scripts/indexer/store";
import { uploadsEnabled } from "./config";
import { deleteStoredFile } from "./storage";
import { getWritableDb } from "./writableDb";

/**
 * Deletes every document past its retention expiry, along with its file
 * and OCR cache entries once nothing else references that content. The
 * tender corpus is never touched: its documents have no expiry at all
 * (expires_at IS NULL), which is exactly what expiredDocuments excludes.
 *
 * Runs at server start and hourly after that (see startRetentionSchedule
 * below), so an expiry missed while the laptop was asleep or off is
 * handled on the next run rather than drifting forever.
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
let intervalHandle: ReturnType<typeof setInterval> | null = null;

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
  intervalHandle = setInterval(run, hourMs);
}

/** Test-only: lets a test start the schedule again after asserting on the first run. */
export function _resetRetentionScheduleForTests(): void {
  scheduled = false;
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

/**
 * The one place that decides whether the retention schedule should be
 * running, called from every entry point that might be the first thing a
 * server process does: the root layout (rendered for every page, so the
 * `npm run share` healthcheck request that confirms the server is up
 * already triggers it, before any upload ever happens) and the uploads
 * route itself (so uploads work even if layout.tsx is ever bypassed, e.g.
 * a direct API call with no page view first).
 *
 * Not a Next.js instrumentation.ts hook: register() runs once at true
 * server start, which sounds like the natural place for this, but isn't
 * reachable safely -- instrumentation.js gets its own file-tracing
 * manifest, entirely separate from every page/route's, and
 * outputFileTracingExcludes (see next.config.ts) only ever applies to the
 * latter. A build actually confirmed this: instrumentation.js's trace
 * pulled in every tender PDF and the OCR cache by the exact mechanism
 * next.config.ts's comment above outputFileTracingExcludes was written to
 * prevent, just through a file it can't reach. Both layout.tsx and the
 * uploads route are already proven (by that same build check) to trace
 * clean, so this stays reachable only through them. Idempotent, so every
 * call after the first is cheap.
 */
export function ensureRetentionScheduleStarted(): void {
  if (uploadsEnabled()) startRetentionSchedule();
}
