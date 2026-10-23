import type Database from "better-sqlite3";

/**
 * The persistent job queue (the `jobs` table in library.db). Guarantees, by
 * construction rather than by care:
 *
 *  - nothing lost: a job is only removed by completeJob(), which callers run
 *    inside the same transaction that writes the job's outcome;
 *  - nothing done twice: at most one job per (source, key) -- UNIQUE -- and
 *    a change arriving while that file is being worked on sets `requeue`
 *    instead of adding a second job;
 *  - resumable: after a crash, sleep, Ctrl+C or the drive being pulled, jobs
 *    left 'running' go back to 'pending' (resetRunningJobs) and are simply
 *    redone; redoing a file replaces whatever partial content it left.
 */

export interface Job {
  id: number;
  sourceId: string;
  key: string;
  locator: string;
  displayName: string;
  action: "index" | "delete";
  sizeBytes: number | null;
  modifiedAt: string | null;
  scanId: number | null;
  attempts: number;
}

export interface NewJob {
  sourceId: string;
  key: string;
  locator: string;
  displayName: string;
  action: "index" | "delete";
  sizeBytes: number | null;
  modifiedAt: string | null;
  scanId: number | null;
  notBefore?: string | null;
}

const now = () => new Date().toISOString();

export function enqueueJob(db: Database.Database, job: NewJob): void {
  db.prepare(
    `INSERT INTO jobs (source_id, key, locator, display_name, action, size_bytes, modified_at, scan_id, state, not_before, enqueued_at, updated_at)
     VALUES (@sourceId, @key, @locator, @displayName, @action, @sizeBytes, @modifiedAt, @scanId, 'pending', @notBefore, @now, @now)
     ON CONFLICT(source_id, key) DO UPDATE SET
       locator = excluded.locator, display_name = excluded.display_name, action = excluded.action,
       size_bytes = excluded.size_bytes, modified_at = excluded.modified_at, scan_id = excluded.scan_id,
       not_before = excluded.not_before, updated_at = excluded.updated_at,
       requeue = CASE WHEN jobs.state = 'running' THEN 1 ELSE jobs.requeue END`
  ).run({ ...job, notBefore: job.notBefore ?? null, now: now() });
}

export function enqueueJobs(db: Database.Database, jobs: NewJob[]): void {
  db.transaction(() => {
    for (const job of jobs) enqueueJob(db, job);
  })();
}

/** Claims up to `limit` ready jobs, oldest first, marking them running. */
export function claimJobs(db: Database.Database, limit: number, nowIso = now()): Job[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, source_id AS sourceId, key, locator, display_name AS displayName, action, size_bytes AS sizeBytes,
                modified_at AS modifiedAt, scan_id AS scanId, attempts
         FROM jobs WHERE state = 'pending' AND (not_before IS NULL OR not_before <= ?)
         ORDER BY id LIMIT ?`
      )
      .all(nowIso, limit) as Job[];
    const mark = db.prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1, requeue = 0, updated_at = ? WHERE id = ?");
    for (const row of rows) mark.run(nowIso, row.id);
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  })();
}

/**
 * Finishes a job. Call inside the transaction that writes its outcome. If
 * the file changed again while it was being worked on, the job goes back to
 * pending instead of being removed.
 */
export function completeJob(db: Database.Database, jobId: number): void {
  const requeue = db.prepare("SELECT requeue FROM jobs WHERE id = ?").pluck().get(jobId) as number | undefined;
  if (requeue === 1) {
    db.prepare("UPDATE jobs SET state = 'pending', requeue = 0, updated_at = ? WHERE id = ?").run(now(), jobId);
  } else {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  }
}

/** Puts a job back for later (a file still being written, or a pause): not an outcome, so it isn't completed. */
export function deferJob(db: Database.Database, jobId: number, notBefore: string | null, reason: string | null): void {
  db.prepare("UPDATE jobs SET state = 'pending', not_before = ?, last_error = ?, updated_at = ? WHERE id = ?").run(notBefore, reason, now(), jobId);
}

/** On start: whatever a previous run left half-done is redone. Returns how many. */
export function resetRunningJobs(db: Database.Database): number {
  return db.prepare("UPDATE jobs SET state = 'pending', updated_at = ? WHERE state = 'running'").run(now()).changes;
}

export function jobCounts(db: Database.Database): { pending: number; running: number; deferred: number } {
  const row = db
    .prepare(
      `SELECT
         sum(state = 'pending' AND (not_before IS NULL OR not_before <= ?)) AS pending,
         sum(state = 'running') AS running,
         sum(state = 'pending' AND not_before > ?) AS deferred
       FROM jobs`
    )
    .get(now(), now()) as { pending: number | null; running: number | null; deferred: number | null };
  return { pending: row.pending ?? 0, running: row.running ?? 0, deferred: row.deferred ?? 0 };
}

/** The earliest time a deferred job becomes ready, or null if none is waiting. */
export function nextDeferredAt(db: Database.Database): string | null {
  return (db.prepare("SELECT min(not_before) FROM jobs WHERE state = 'pending' AND not_before IS NOT NULL").pluck().get() as string | null) ?? null;
}
