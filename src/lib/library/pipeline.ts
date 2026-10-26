import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLimiter } from "../../../scripts/indexer/exec";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import type { LibraryConfig, LibraryPaths } from "./config";
import { extractPages, extractSettingsKey, inspectPdf } from "./extract";
import { claimJobs, completeJob, deferJob, enqueueJobs, jobCounts, resetRunningJobs, type Job, type NewJob } from "./jobs";
import type { FailureKind } from "./schema";
import { SourceFileError, StillChangingError, type LibrarySource, type SourceEntry } from "./sources/types";
import { sleep } from "./storage/guard";
import { limitStateLabel, type LimitState } from "./storage/limits";
import {
  beginDocument,
  clearFailure,
  deleteLibraryDocument,
  failDocument,
  finishScan,
  knownDocuments,
  knownFailures,
  markDocumentReady,
  markFailuresSeen,
  markSeen,
  openLibraryDb,
  quickCheck,
  recordFailure,
  registerSource,
  renameCandidate,
  renameLibraryDocument,
  startScan,
  sweepFailures,
  touchDocument,
  unseenDocuments,
  writePages,
} from "./store";
import type { SkipReason, SkipRecord } from "./walk";

/**
 * The library indexing pipeline: scan sources -> persistent job queue ->
 * a bounded pool of workers -> page-by-page extraction -> the library index.
 *
 * The scan and the workers run at the same time, so search works on
 * whatever is indexed so far. Everything is resumable: a crash, sleep,
 * Ctrl+C or the drive being pulled leaves jobs 'running', which the next
 * start (or the reconnect) puts back to 'pending'; redoing a file replaces
 * whatever partial content it left, and the OCR cache means OCR isn't
 * redone.
 *
 * Storage rule, enforced here at run time (storage/guard.ts did the volume
 * check at start): before every write the guard confirms the drive is still
 * the one that was checked; if not, everything stops cleanly, the database
 * is closed, and the run waits for the same drive to come back, checks the
 * index (PRAGMA quick_check), and carries on. Free space is checked before
 * starting and every `spaceCheckMs`; below the minimum, work pauses until
 * space is freed.
 */

export interface GuardLike {
  readonly paths: LibraryPaths;
  isConnected(): boolean;
  verifyConnected(): Promise<boolean>;
  waitForReconnect(signal: AbortSignal, intervalMs?: number, onWait?: () => void): Promise<boolean>;
  /** The storage cap and the free-space reserve. */
  checkLimits(): LimitState;
}

export type IndexerState =
  | "starting"
  | "running"
  | "paused: storage limit"
  | "paused: low disk space"
  | "paused: library drive not connected"
  | "stopping"
  | "done";

export interface FailureEvent {
  at: string;
  source: string;
  file: string;
  kind: FailureKind | "deferred";
  message: string | null;
}

export interface PipelineOptions {
  config: LibraryConfig;
  guard: GuardLike;
  sources: LibrarySource[];
  log?: (line: string) => void;
  onFailure?: (event: FailureEvent) => void;
  retryFailed?: boolean;
  /** Test hooks. */
  openDb?: (file: string) => Database.Database;
  reconnectIntervalMs?: number;
  spaceCheckMs?: number;
  idlePollMs?: number;
  /** Called before every index write; a test throws from it to simulate an I/O error. */
  beforeWrite?: () => void;
  now?: () => number;
}

export interface Progress {
  state: IndexerState;
  startedAt: number;
  scanFilesSeen: number;
  scanSkipped: number;
  scanOthers: number;
  scanning: boolean;
  queued: number;
  running: number;
  deferred: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesRenamed: number;
  filesDeleted: number;
  filesFailed: number;
  pagesDone: number;
  ocrRun: number;
  ocrCached: number;
  freeBytes: number | null;
  usedBytes: number | null;
  capBytes: number | null;
  /** The limit currently pausing indexing, or null. */
  limit: Extract<LimitState, { ok: false }> | null;
  /** Pages finished in the last 60 s, with timestamps, for a rolling rate. */
  recentPages: Array<[number, number]>;
}

/** A scan that never finishes is held back by this sentinel: jobs for new paths in a rescan wait until it's complete (see enqueue). */
const AWAITING_SCAN = "9999-12-31T00:00:00.000Z";
const WRITE_CHUNK_PAGES = 25;

class Disconnected extends Error {}

function isIoError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code ?? "");
  return code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN" || code === "SQLITE_FULL" || code === "EIO" || code === "ENXIO" || code === "ENOENT";
}

function skipKind(reason: SkipReason): FailureKind {
  switch (reason) {
    case "permission-denied":
    case "path-too-long":
    case "vanished":
    case "unreadable-filename":
    case "symlink":
    case "other-device":
    case "directory-cycle":
    case "too-large":
    case "not-downloaded":
    case "too-deep":
    case "not-a-pdf":
      return reason;
    default:
      return "other";
  }
}

export class LibraryIndexer {
  private db: Database.Database | null = null;
  private ocrCache: OcrCache | null = null;
  private readonly log: (line: string) => void;
  private readonly settings: string;
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly sourcesById: Map<string, LibrarySource>;
  private readonly now: () => number;
  private paused: Promise<void> | null = null;
  private pausedFor: "disconnect" | "limit" | null = null;
  private stopped = false;
  private stopController = new AbortController();
  private fileControllers = new Set<AbortController>();
  private scanCompleted = new Map<string, number>();
  readonly progress: Progress;

  constructor(private readonly o: PipelineOptions) {
    this.log = o.log ?? (() => {});
    this.settings = extractSettingsKey(o.config);
    this.limit = createLimiter(o.config.concurrency);
    this.sourcesById = new Map(o.sources.map((s) => [s.id, s]));
    this.now = o.now ?? Date.now;
    this.progress = {
      state: "starting",
      startedAt: this.now(),
      scanFilesSeen: 0,
      scanSkipped: 0,
      scanOthers: 0,
      scanning: false,
      queued: 0,
      running: 0,
      deferred: 0,
      filesIndexed: 0,
      filesUnchanged: 0,
      filesRenamed: 0,
      filesDeleted: 0,
      filesFailed: 0,
      pagesDone: 0,
      ocrRun: 0,
      ocrCached: 0,
      freeBytes: null,
      usedBytes: null,
      capBytes: null,
      limit: null,
      recentPages: [],
    };
  }

  private get paths(): LibraryPaths {
    return this.o.guard.paths;
  }

  // --- connection management ------------------------------------------------

  private open(): void {
    this.db = (this.o.openDb ?? openLibraryDb)(this.paths.db);
    this.ocrCache = new OcrCache(this.paths.ocrCache);
  }

  private closeQuietly(): void {
    try {
      this.db?.close();
    } catch {
      // the file may already be gone with the drive
    }
    try {
      this.ocrCache?.close();
    } catch {
      // same
    }
    this.db = null;
    this.ocrCache = null;
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Disconnected("library index closed");
    return this.db;
  }

  /** Every write goes through here: the drive must still be the one checked at start. */
  private write<T>(fn: (db: Database.Database) => T): T {
    if (!this.o.guard.isConnected()) throw new Disconnected("library drive not connected");
    const db = this.requireDb();
    this.o.beforeWrite?.();
    try {
      return fn(db);
    } catch (err) {
      if (isIoError(err) || !this.o.guard.isConnected()) throw new Disconnected(String((err as Error)?.message ?? err));
      throw err;
    }
  }

  /** Workers and the scanner call this between steps: waits out a pause, throws if stopping. */
  private async checkpoint(): Promise<void> {
    while (this.paused) await this.paused;
    if (this.stopped) throw new Error("stopping");
  }

  /** Drive gone: stop everything, close the index, wait for the same drive, check the index, resume. */
  private onDisconnect(): Promise<void> {
    if (this.paused) return this.paused;
    this.pausedFor = "disconnect";
    this.progress.state = "paused: library drive not connected";
    this.log("Library drive not connected. Stopped safely; waiting for it to come back…");
    for (const c of this.fileControllers) c.abort();
    this.paused = (async () => {
      this.closeQuietly();
      const back = await this.o.guard.waitForReconnect(this.stopController.signal, this.o.reconnectIntervalMs ?? 10_000);
      if (!back) return;
      this.open();
      if (!quickCheck(this.requireDb())) {
        this.stop();
        throw new Error(`The library index at ${this.paths.db} failed its integrity check after the drive came back. Stop, move it aside, and rebuild.`);
      }
      const redo = resetRunningJobs(this.requireDb());
      this.log(`Library drive is back; index checks out. Resuming (${redo} file(s) to redo).`);
      this.progress.state = "running";
    })().finally(() => {
      this.paused = null;
    });
    return this.paused;
  }

  /**
   * Checks the storage cap and the free-space reserve, records the numbers
   * for the status line, and -- if either is hit -- pauses everything.
   * Cheap (a few stats and one statfs), so it runs before every claim and
   * before every big write, plus on a timer.
   */
  private enforceLimits(): LimitState | null {
    let state: LimitState;
    try {
      state = this.o.guard.checkLimits();
    } catch {
      return null; // the drive may be gone; the connection checks handle that
    }
    this.progress.usedBytes = state.usedBytes;
    this.progress.capBytes = state.capBytes;
    this.progress.freeBytes = state.freeBytes;
    if (!state.ok && !this.paused && !this.stopped) void this.onLimit(state);
    return state;
  }

  /**
   * A limit was hit. Workers stop claiming, in-flight files stop at their
   * next checkpoint (their jobs go back to pending: redoing a file replaces
   * whatever partial content it left, and the OCR cache avoids repeating
   * OCR), temp files go with them -- and NOTHING else is deleted to make
   * room. Resumes by itself once usage is back under the cap and the disk is
   * back above the reserve. Search keeps working throughout (the app only
   * reads the index).
   */
  private onLimit(first: Extract<LimitState, { ok: false }>): Promise<void> {
    if (this.paused) return this.paused;
    this.pausedFor = "limit";
    this.progress.state = limitStateLabel(first.kind);
    this.progress.limit = first;
    this.log(first.message);
    for (const c of this.fileControllers) c.abort();
    this.paused = (async () => {
      let lastReminder = this.now();
      for (;;) {
        await sleep(this.o.spaceCheckMs ?? 30_000, this.stopController.signal);
        if (this.stopped) return;
        let state: LimitState;
        try {
          state = this.o.guard.checkLimits();
        } catch {
          continue; // drive trouble: the next write notices and handles it
        }
        this.progress.usedBytes = state.usedBytes;
        this.progress.capBytes = state.capBytes;
        this.progress.freeBytes = state.freeBytes;
        if (state.ok) break;
        this.progress.state = limitStateLabel(state.kind);
        this.progress.limit = state;
        if (this.now() - lastReminder > 5 * 60_000) {
          this.log(state.message);
          lastReminder = this.now();
        }
      }
      try {
        const redo = resetRunningJobs(this.requireDb());
        this.log(`Back under the limits. Resuming (${redo} file(s) to redo).`);
      } catch {
        // index closed (stopping)
      }
      this.progress.state = "running";
      this.progress.limit = null;
    })().finally(() => {
      this.paused = null;
      this.pausedFor = null;
    });
    return this.paused;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.progress.state = "stopping";
    this.stopController.abort();
    for (const c of this.fileControllers) c.abort();
  }

  // --- the run ---------------------------------------------------------------

  /**
   * One pass: scan every source, index everything queued, then remove what
   * a completed scan didn't find. Returns when the queue is empty (or on
   * stop()). With `watch`, keeps rescanning every rescanMinutes.
   */
  async run(options: { watch?: boolean } = {}): Promise<Progress> {
    this.open();
    try {
      const db = this.requireDb();
      const redo = resetRunningJobs(db);
      if (redo > 0) this.log(`Resuming: ${redo} file(s) a previous run left half-done will be redone.`);
      for (const s of this.o.sources) registerSource(db, s);
      this.emptyTempDir();
      this.progress.state = "running";

      const spaceTimer = setInterval(() => void this.enforceLimits(), this.o.spaceCheckMs ?? 30_000);
      this.enforceLimits();

      try {
        do {
          await this.cycle();
          if (!options.watch || this.stopped) break;
          this.log(`Next rescan in ${this.o.config.rescanMinutes} min.`);
          await sleep(this.o.config.rescanMinutes * 60_000, this.stopController.signal);
        } while (!this.stopped);
      } finally {
        clearInterval(spaceTimer);
      }
      if (!this.stopped) this.progress.state = "done";
      return this.progress;
    } finally {
      this.closeQuietly();
    }
  }

  private emptyTempDir(): void {
    fs.mkdirSync(this.paths.tmp, { recursive: true });
    for (const name of fs.readdirSync(this.paths.tmp)) {
      fs.rmSync(path.join(this.paths.tmp, name), { recursive: true, force: true });
    }
  }

  private async cycle(): Promise<void> {
    this.scanCompleted.clear();
    let scanDone = false;
    const scanning = this.scanAll();
    const workers = Array.from({ length: this.o.config.filesInFlight }, () => this.worker(() => scanDone));
    await scanning.finally(() => {
      scanDone = true;
    });
    await Promise.all(workers);
    if (!this.stopped) await this.sweep();
  }

  // --- scanning ----------------------------------------------------------------

  private async scanAll(): Promise<void> {
    this.progress.scanning = true;
    try {
      for (const source of this.o.sources) {
        if (this.stopped) return;
        await this.scanSource(source);
      }
    } finally {
      this.progress.scanning = false;
    }
  }

  private async scanSource(source: LibrarySource): Promise<void> {
    await this.checkpoint();
    const scanId = this.write((db) => startScan(db, source.id));
    const hadDocuments = this.write(
      (db) => db.prepare("SELECT 1 FROM documents WHERE source_id = ? LIMIT 1").get(source.id) !== undefined
    );
    const stats = { filesSeen: 0, queued: 0, skipped: 0, others: 0 };
    const skippedDirs: string[] = [];
    let rootUnreachable = false;
    let batch: SourceEntry[] = [];
    const skips: SkipRecord[] = [];
    const sample = this.o.config.sample;
    const reservoir: SourceEntry[] = [];
    const rng = mulberry32(this.o.config.sampleSeed);

    const onSkip = (s: SkipRecord) => {
      stats.skipped++;
      this.progress.scanSkipped++;
      if (s.relPath === "") rootUnreachable = true;
      if (s.isDirectory && s.relPath) {
        if (skippedDirs.length <= 10_000) skippedDirs.push(s.relPath);
      }
      skips.push(s);
    };
    const onOther = () => {
      stats.others++;
      this.progress.scanOthers++;
    };

    const flush = async () => {
      await this.checkpoint();
      if (skips.length > 0) {
        const pending = skips.splice(0);
        this.write((db) =>
          db.transaction(() => {
            for (const s of pending) {
              const kind = skipKind(s.reason);
              recordFailure(db, {
                sourceId: source.id,
                key: s.isDirectory ? `${s.relPath}/` : s.relPath,
                displayName: s.isDirectory ? `${s.relPath}/` : s.relPath,
                kind,
                message: s.detail ?? s.reason,
                scanId,
              });
              this.o.onFailure?.({ at: new Date().toISOString(), source: source.id, file: s.relPath, kind, message: s.detail ?? s.reason });
            }
          })()
        );
      }
      if (batch.length === 0) return;
      const entries = batch;
      batch = [];
      this.write((db) => {
        const keys = entries.map((e) => e.key);
        const known = knownDocuments(db, source.id, keys);
        const failed = knownFailures(db, source.id, keys);
        const jobs: NewJob[] = [];
        const seen: string[] = [];
        const failuresSeen: string[] = [];
        for (const e of entries) {
          const doc = known.get(e.key);
          const failure = failed.get(e.key);
          const unchanged = (x: { sizeBytes: number | null; modifiedAt: string | null }) =>
            x.sizeBytes === e.sizeBytes && x.modifiedAt === e.modifiedAt;
          if (doc) {
            seen.push(e.key);
            const settled = doc.settings === this.settings;
            if (unchanged(doc) && settled && (doc.status === "ready" || (doc.status === "failed" && !this.o.retryFailed))) continue;
          } else if (failure && unchanged(failure) && !this.o.retryFailed) {
            failuresSeen.push(e.key);
            continue;
          }
          // A new path in a source that already has documents might be a
          // rename; that can only be told once the scan has finished (a
          // document not seen anywhere), so it waits until then.
          const notBefore = e.notBefore ?? (!doc && hadDocuments ? AWAITING_SCAN : null);
          jobs.push({
            sourceId: source.id,
            key: e.key,
            locator: e.locator,
            displayName: e.displayName,
            action: "index",
            sizeBytes: e.sizeBytes,
            modifiedAt: e.modifiedAt,
            scanId,
            notBefore,
          });
        }
        db.transaction(() => {
          markSeen(db, source.id, seen, scanId);
          markFailuresSeen(db, source.id, failuresSeen, scanId);
          enqueueJobs(db, jobs);
        })();
        stats.queued += jobs.length;
      });
    };

    let completed = false;
    let abortedReason: string | undefined;
    try {
      for await (const entry of source.scan(this.stopController.signal, onSkip, onOther)) {
        stats.filesSeen++;
        this.progress.scanFilesSeen++;
        if (sample) {
          // Reservoir sampling: a uniform random `sample` of every PDF, in constant memory.
          if (reservoir.length < sample) reservoir.push(entry);
          else {
            const j = Math.floor(rng() * stats.filesSeen);
            if (j < sample) reservoir[j] = entry;
          }
          continue;
        }
        batch.push(entry);
        if (batch.length >= 200 || skips.length >= 200) await flush();
      }
      if (sample) batch.push(...reservoir);
      await flush();
      completed = !this.stopped && !rootUnreachable;
      if (rootUnreachable) abortedReason = "source root unreachable";
    } catch (err) {
      if (err instanceof Disconnected) {
        abortedReason = "library drive disconnected";
        await this.onDisconnect().catch(() => {});
      } else if (this.stopped) {
        abortedReason = "stopped";
      } else {
        abortedReason = err instanceof Error ? err.message : String(err);
        this.log(`Scan of ${source.label} failed: ${abortedReason}`);
      }
    }

    await this.checkpoint().catch(() => {});
    if (this.stopped && !this.db) return;
    try {
      this.write((db) => {
        finishScan(db, scanId, stats, { completed, abortedReason });
        // New paths held back for rename detection can go now.
        db.prepare("UPDATE jobs SET not_before = NULL WHERE source_id = ? AND not_before = ?").run(source.id, AWAITING_SCAN);
      });
    } catch {
      // stopping or disconnected; the next run rescans
    }
    if (completed && !sample) this.scanCompleted.set(source.id, scanId);
    // Directories that couldn't be read this time: don't treat what's in them as deleted.
    this.skippedDirsBySource.set(source.id, skippedDirs.length > 10_000 ? null : skippedDirs);
    if (sample) this.log(`Sample mode: indexing a random ${reservoir.length} of ${stats.filesSeen} PDFs (seed ${this.o.config.sampleSeed}); deletions aren't swept in sample mode.`);
  }

  private skippedDirsBySource = new Map<string, string[] | null>();

  /** After a completed scan and an empty queue: documents not seen are files that are gone. */
  private async sweep(): Promise<void> {
    for (const [sourceId, scanId] of this.scanCompleted) {
      const skippedDirs = this.skippedDirsBySource.get(sourceId);
      if (skippedDirs === null) {
        this.log(`Not removing anything for ${sourceId}: over 10,000 folders were unreadable this scan.`);
        continue;
      }
      const under = (key: string) => (skippedDirs ?? []).some((d) => key.startsWith(`${d}/`));
      let removed = 0;
      for (;;) {
        const ids = this.write((db) => unseenDocuments(db, sourceId, scanId, 500));
        const toDelete = this.write((db) =>
          ids.filter((id) => !under(String(db.prepare("SELECT key FROM documents WHERE id = ?").pluck().get(id))))
        );
        if (toDelete.length === 0) break;
        this.write((db) => db.transaction(() => toDelete.forEach((id) => deleteLibraryDocument(db, id)))());
        removed += toDelete.length;
        if (toDelete.length < ids.length) break;
      }
      this.write((db) => sweepFailures(db, sourceId, scanId));
      if (removed > 0) {
        this.progress.filesDeleted += removed;
        this.log(`Removed ${removed} document(s) no longer in ${this.sourcesById.get(sourceId)?.label ?? sourceId}.`);
      }
    }
  }

  // --- workers -------------------------------------------------------------------

  private refreshCounts(): void {
    try {
      const c = jobCounts(this.requireDb());
      this.progress.queued = c.pending;
      this.progress.running = c.running;
      this.progress.deferred = c.deferred;
    } catch {
      // disconnected
    }
  }

  private async worker(scanDone: () => boolean): Promise<void> {
    while (!this.stopped) {
      try {
        await this.checkpoint();
      } catch {
        return;
      }
      let job: Job | undefined;
      try {
        const limits = this.enforceLimits();
        if (limits && !limits.ok) {
          await this.checkpoint(); // waits out the pause (or throws if stopping)
          continue;
        }
        job = this.write((db) => claimJobs(db, 1)[0]);
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof Disconnected) {
          await this.onDisconnect().catch((e) => this.log(String(e)));
          continue;
        }
        throw err;
      }
      this.refreshCounts();
      if (!job) {
        if (scanDone()) {
          const c = (() => {
            try {
              return jobCounts(this.requireDb());
            } catch {
              return null;
            }
          })();
          if (c && c.running === 0 && c.pending === 0) {
            // Only deferred jobs left (files still being written, or held
            // for rename detection): wait for them, unless none are coming.
            const next = this.requireDb()
              .prepare("SELECT min(not_before) FROM jobs WHERE state = 'pending'")
              .pluck()
              .get() as string | null;
            if (!next) return;
          }
        }
        await sleep(this.o.idlePollMs ?? 500, this.stopController.signal);
        continue;
      }
      await this.process(job);
    }
  }

  private async process(job: Job): Promise<void> {
    const source = this.sourcesById.get(job.sourceId);
    if (!source) {
      // Its source is no longer configured: drop the job.
      this.write((db) => db.transaction(() => completeJob(db, job.id))());
      return;
    }
    if (job.action === "delete") {
      this.write((db) =>
        db.transaction(() => {
          const id = db.prepare("SELECT id FROM documents WHERE source_id = ? AND key = ?").pluck().get(job.sourceId, job.key) as number | undefined;
          if (id !== undefined) deleteLibraryDocument(db, id);
          completeJob(db, job.id);
        })()
      );
      return;
    }

    const controller = new AbortController();
    this.fileControllers.add(controller);
    // Waits out a pause -- but a file a pause released (its controller was
    // aborted) must not carry on afterwards holding its temp files: it stops
    // here, cleans up, and is redone when the pause ends.
    const hold = async () => {
      if (controller.signal.aborted) throw new Error("released by a pause");
      await this.checkpoint();
      if (controller.signal.aborted) throw new Error("released by a pause");
    };
    const fileTmp = fs.mkdtempSync(path.join(this.paths.tmp, "file-"));
    const entry: SourceEntry = {
      key: job.key,
      displayName: job.displayName,
      locator: job.locator,
      sizeBytes: job.sizeBytes,
      modifiedAt: job.modifiedAt,
    };
    let opened: Awaited<ReturnType<LibrarySource["open"]>> | null = null;
    let docId: number | null = null;
    const fail = (kind: FailureKind, message: string) => {
      this.progress.filesFailed++;
      this.write((db) =>
        db.transaction(() => {
          recordFailure(db, {
            sourceId: job.sourceId,
            key: job.key,
            displayName: job.displayName,
            kind,
            message,
            sizeBytes: job.sizeBytes,
            modifiedAt: job.modifiedAt,
            scanId: job.scanId,
          });
          const existing = docId ?? (db.prepare("SELECT id FROM documents WHERE source_id = ? AND key = ?").pluck().get(job.sourceId, job.key) as number | undefined);
          // A file that now fails no longer matches what was indexed from
          // it before: don't keep serving stale content for it.
          if (existing !== undefined) deleteLibraryDocument(db, existing);
          completeJob(db, job.id);
        })()
      );
      this.o.onFailure?.({ at: new Date().toISOString(), source: job.sourceId, file: job.displayName, kind, message });
    };

    try {
      opened = await source.open(entry, fileTmp, controller.signal);
      const file = opened;
      await hold();

      const known = this.write((db) => knownDocuments(db, job.sourceId, [job.key]).get(job.key));
      if (known && known.sha256 === file.sha256 && known.settings === this.settings && known.status === "ready") {
        this.write((db) =>
          db.transaction(() => {
            touchDocument(db, known.id, { sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, scanId: job.scanId });
            clearFailure(db, job.sourceId, job.key);
            completeJob(db, job.id);
          })()
        );
        this.progress.filesUnchanged++;
        return;
      }
      if (!known && job.scanId !== null) {
        const candidate = this.write((db) => renameCandidate(db, job.sourceId, file.sha256, this.settings, job.scanId!));
        if (candidate !== null) {
          this.write((db) =>
            db.transaction(() => {
              renameLibraryDocument(db, candidate, {
                key: job.key,
                displayName: job.displayName,
                sizeBytes: file.sizeBytes,
                modifiedAt: file.modifiedAt,
                scanId: job.scanId,
              });
              clearFailure(db, job.sourceId, job.key);
              completeJob(db, job.id);
            })()
          );
          this.progress.filesRenamed++;
          return;
        }
      }

      const info = await this.limit(() => inspectPdf(file.path, this.o.config.pageTimeoutMs));
      docId = this.write((db) =>
        beginDocument(db, {
          sourceId: job.sourceId,
          key: job.key,
          displayName: job.displayName,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          sha256: file.sha256,
          pageCount: info.pageCount,
          ocrLang: this.o.config.ocrLang,
          settings: this.settings,
          encryption: info.encryption === "restricted" ? "restricted" : null,
          scanId: job.scanId,
        })
      );
      const stats = { ocrRun: 0, ocrCached: 0 };
      let buffer: ExtractedPage[] = [];
      const flushPages = async (pages: ExtractedPage[]) => {
        this.enforceLimits();
        await hold();
        this.write((db) => writePages(db, docId!, pages));
        this.progress.pagesDone += pages.length;
        this.progress.recentPages.push([this.now(), pages.length]);
      };
      for await (const page of extractPages(file.path, file.sha256, file.sizeBytes, info, {
        ocrPages: this.o.config.ocrPages,
        ocrLang: this.o.config.ocrLang,
        ocrDpi: this.o.config.ocrDpi,
        pageTimeoutMs: this.o.config.pageTimeoutMs,
        pageWindow: this.o.config.pageWindow,
        labelsMaxBytes: this.o.config.labelsMaxBytes,
        deadline: this.now() + this.o.config.fileTimeoutMs,
        limit: this.limit,
        ocrCache: this.ocrCache!,
        tempDir: fileTmp,
        signal: controller.signal,
        stats,
      })) {
        buffer.push(page);
        if (buffer.length >= WRITE_CHUNK_PAGES) {
          const chunk = buffer;
          buffer = [];
          await flushPages(chunk);
        }
      }
      await hold();
      const last = buffer;
      this.write((db) =>
        db.transaction(() => {
          if (last.length > 0) writePages(db, docId!, last);
          markDocumentReady(db, docId!);
          clearFailure(db, job.sourceId, job.key);
          completeJob(db, job.id);
        })()
      );
      if (last.length > 0) {
        this.progress.pagesDone += last.length;
        this.progress.recentPages.push([this.now(), last.length]);
      }
      this.progress.ocrRun += stats.ocrRun;
      this.progress.ocrCached += stats.ocrCached;
      this.progress.filesIndexed++;
    } catch (err) {
      if (this.stopped) return; // not an outcome: redone next run
      if (controller.signal.aborted) {
        // Released by a pause (a storage limit, or the drive going away): not
        // an outcome. The job stays 'running' and is redone when the pause
        // ends. Returns at once so this file's temp files are removed now
        // (the worker loop then waits out the pause).
        return;
      }
      if (err instanceof Disconnected) {
        // The drive went away under this write: stop everything and wait for it.
        await this.onDisconnect().catch((e) => this.log(String(e)));
        return;
      }
      try {
        if (err instanceof StillChangingError) {
          const retryAt = new Date(this.now() + this.o.config.settleSeconds * 1000).toISOString();
          this.write((db) => deferJob(db, job.id, retryAt, err.message));
          this.o.onFailure?.({ at: new Date().toISOString(), source: job.sourceId, file: job.displayName, kind: "deferred", message: `still being written; retrying after ${retryAt}` });
        } else if (err instanceof SourceFileError) {
          if (docId !== null && err.kind === "timeout") this.write((db) => failDocument(db, docId!, err.message));
          fail(err.kind, err.message);
        } else {
          fail("other", err instanceof Error ? err.message : String(err));
        }
      } catch (inner) {
        if (inner instanceof Disconnected) await this.onDisconnect().catch((e) => this.log(String(e)));
        else throw inner;
      }
    } finally {
      this.fileControllers.delete(controller);
      await opened?.cleanup().catch(() => {});
      await fs.promises.rm(fileTmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Small seeded PRNG, so a sample is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
