import type Database from "better-sqlite3";
import { codeOf, ERRORS, type ErrorCode } from "../errors/catalog";
import type { LibraryConfig } from "../library/config";
import { libraryPaths } from "../library/config";
import { readWorker, type WorkerView } from "../library/sources/view";
import { diskInfo } from "./disk";
import { checkToolsCached } from "./tools";
import { readPreflight, observedRatio, planSpace } from "./preflight";
import { describeServer, serverFingerprint } from "./config";
import path from "node:path";

/**
 * Everything the Server page and the banner need, from the index and the worker's own status. Built on demand
 * from the library database (read-only), so it works while the storage server is down: what is already indexed
 * is searchable whatever the server is doing.
 */

export const SERVER_SOURCE_ID = "env-server";

/** A skipped file's reason in plain words (the tool's own message goes along in `detail`). */
export function describeFailure(kind: string, message: string | null): string {
  switch (kind) {
    case "corrupt":
      return "This PDF is damaged, so it can't be read.";
    case "encrypted":
      return "This PDF needs a password to open, so it was skipped.";
    case "timeout":
      return "Reading this PDF took too long, so it was skipped.";
    case "too-large":
      return "This PDF is bigger than the size limit, so it was skipped.";
    case "not-a-pdf":
      return "This file isn't a PDF (it doesn't start with a PDF header), so it was skipped.";
    case "permission-denied":
      return "The server wouldn't let Locus read this file (no permission).";
    case "vanished":
      return "This file was removed from the server while it was being read.";
    default:
      return message ?? "It couldn't be read.";
  }
}

export interface ServerStatus {
  configured: boolean;
  type: "none" | "folder" | "s3";
  label: string;
  configError: string | null;
  syncIntervalMin: number | null;
  indexer: { running: boolean; state: string | null };
  index: {
    documents: number;
    pagesIndexed: number;
    ocrPagesRun: number | null;
    failed: number;
    /** Files waiting or being worked on. */
    pending: number;
    /** Every file the last scan found: indexed + failed + waiting. */
    total: number;
    percent: number | null;
    filesPerMinute: number | null;
    etaSeconds: number | null;
  };
  sync: { lastSyncedAt: string | null; scanning: boolean; error: { code: ErrorCode | null; message: string } | null };
  space: null | {
    freeBytes: number;
    reserveBytes: number;
    usableBytes: number;
    indexBytes: number | null;
    pdfBytes: number | null;
    estimateBytes: number | null;
    /** Where the estimate comes from: the default ratio, or the one seen on this index so far. */
    ratioSource: "default" | "observed" | null;
    fits: boolean | null;
  };
  failures: Array<{ file: string; kind: string; message: string; detail: string | null; at: string }>;
  banner: { code: ErrorCode | null; tone: "error" | "warning" | "info"; title: string; message: string; action: string | null } | null;
}

const none: ServerStatus["index"] = { documents: 0, pagesIndexed: 0, ocrPagesRun: null, failed: 0, pending: 0, total: 0, percent: null, filesPerMinute: null, etaSeconds: null };

export function buildServerStatus(library: Database.Database | null, config: LibraryConfig, now = Date.now()): ServerStatus {
  const cfg = config.server;
  const configured = cfg.type !== "none";
  const base: ServerStatus = {
    configured,
    type: cfg.type,
    label: "",
    configError: config.serverError,
    syncIntervalMin: configured ? cfg.syncIntervalMin : null,
    indexer: { running: false, state: null },
    index: { ...none },
    sync: { lastSyncedAt: null, scanning: false, error: null },
    space: null,
    failures: [],
    banner: null,
  };
  if (config.serverError) {
    const e = ERRORS["LOCUS-SERVER-003"];
    base.banner = { code: "LOCUS-SERVER-003", tone: "error", title: e.title, message: `${e.message} ${config.serverError}`, action: e.action };
    return base;
  }
  if (!configured) return base;
  base.label = describeServer(cfg);

  const worker: WorkerView = readWorker(library, now);
  base.indexer = { running: worker.running, state: worker.state };
  const paths = libraryPaths(config.dataDir);
  let lastError: string | null = null;

  if (library) {
    try {
      const c = library
        .prepare("SELECT coalesce(sum(status = 'ready'), 0) AS ready, coalesce(sum(status = 'failed'), 0) AS failed, coalesce(sum(pages_done), 0) AS pages, coalesce(sum(CASE WHEN status = 'ready' THEN size_bytes ELSE 0 END), 0) AS bytes FROM documents WHERE source_id = ?")
        .get(SERVER_SOURCE_ID) as { ready: number; failed: number; pages: number; bytes: number };
      const pending = Number(library.prepare("SELECT count(*) FROM jobs WHERE source_id = ? AND state IN ('pending','running')").pluck().get(SERVER_SOURCE_ID));
      // A file that can't be read leaves no document row (any earlier copy is removed), only a line in `failures`: that is what is counted.
      const failedCount = Number(library.prepare("SELECT count(*) FROM failures WHERE source_id = ? AND kind != 'deferred'").pluck().get(SERVER_SOURCE_ID));
      const total = c.ready + failedCount + pending;
      const since = new Date(now - 10 * 60_000).toISOString();
      const recent = Number(library.prepare("SELECT count(*) FROM documents WHERE source_id = ? AND status = 'ready' AND indexed_at > ?").pluck().get(SERVER_SOURCE_ID, since));
      const perMin = recent > 0 ? recent / 10 : null;
      const worked = (JSON.parse((library.prepare("SELECT value FROM meta WHERE key = 'worker_status'").pluck().get() as string | undefined) ?? "{}") as { ocrRun?: number }).ocrRun;
      base.index = {
        documents: c.ready,
        pagesIndexed: c.pages,
        ocrPagesRun: typeof worked === "number" ? worked : null,
        failed: failedCount,
        pending,
        total,
        percent: total > 0 ? Math.round(((c.ready + failedCount) / total) * 100) : null,
        filesPerMinute: perMin,
        etaSeconds: pending > 0 && perMin ? Math.round((pending / perMin) * 60) : null,
      };
      const scan = library.prepare("SELECT finished_at, completed FROM scans WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(SERVER_SOURCE_ID) as { finished_at: string | null; completed: number } | undefined;
      base.sync.scanning = scan ? scan.finished_at === null : false;
      base.sync.lastSyncedAt = (library.prepare("SELECT max(finished_at) FROM scans WHERE source_id = ? AND completed = 1").pluck().get(SERVER_SOURCE_ID) as string | null) ?? null;
      lastError = (library.prepare("SELECT last_error FROM sources WHERE id = ?").pluck().get(SERVER_SOURCE_ID) as string | null | undefined) ?? null;
      base.failures = (
        library.prepare("SELECT display_name AS file, kind, message, at FROM failures WHERE source_id = ? AND kind != 'deferred' ORDER BY at DESC LIMIT 200").all(SERVER_SOURCE_ID) as Array<{ file: string; kind: string; message: string | null; at: string }>
      ).map((f) => ({ file: f.file, kind: f.kind, message: describeFailure(f.kind, f.message), detail: f.message, at: f.at }));

      // Space: what's free now, what the index is using, and what the rest is expected to take.
      const disk = diskInfo(config.dataDir);
      const pre = readPreflight(path.join(paths.root, "server-preflight.json"));
      const samePlace = pre && pre.fingerprint === serverFingerprint(cfg);
      const indexBytes = worker.usedBytes;
      const ratio = indexBytes !== null ? observedRatio(indexBytes, c.bytes, c.ready) : null;
      const pdfBytes = samePlace ? pre.pdfBytes : null;
      const plan = pdfBytes !== null ? planSpace({ files: pre!.files, pdfBytes, ratio: ratio ?? undefined, freeBytes: disk.freeBytes, reserveBytes: config.minFreeBytes, indexBytes: indexBytes ?? 0 }) : null;
      base.space = {
        freeBytes: disk.freeBytes,
        reserveBytes: config.minFreeBytes,
        usableBytes: disk.freeBytes - config.minFreeBytes,
        indexBytes,
        pdfBytes,
        estimateBytes: plan?.estimateBytes ?? null,
        ratioSource: plan ? (ratio !== null ? "observed" : "default") : null,
        fits: plan?.fits ?? null,
      };
    } catch {
      // The index is being written to or is momentarily unavailable: show what is known.
    }
  }
  base.sync.error = lastError ? { code: codeOf(lastError), message: lastError.replace(/^LOCUS-[A-Z]+-\d{3}:\s*/, "") } : null;

  // One banner, most important first.
  const entry = (code: ErrorCode) => ERRORS[code];
  if (lastError) {
    const code = codeOf(lastError);
    base.banner = { code, tone: "error", title: code ? entry(code).title : "The storage server has a problem", message: lastError.replace(/^LOCUS-[A-Z]+-\d{3}:\s*/, ""), action: code ? entry(code).action : null };
  } else if (worker.limit) {
    const e = entry("LOCUS-DISK-002");
    base.banner = { code: "LOCUS-DISK-002", tone: "warning", title: e.title, message: worker.limit.message, action: e.action };
  } else if (!checkToolsCached().poppler.ok) {
    const e = entry("LOCUS-TOOL-002");
    base.banner = { code: "LOCUS-TOOL-002", tone: "error", title: e.title, message: e.message, action: e.action };
  } else if (!worker.running) {
    base.banner = { code: null, tone: "warning", title: "The indexer isn't running", message: "Nothing new is being indexed or synced. Everything already indexed is still searchable.", action: "Start Locus with `npm start` (it starts the indexer too)." };
  } else if (!checkToolsCached().tesseract.ok) {
    const e = entry("LOCUS-TOOL-001");
    base.banner = { code: "LOCUS-TOOL-001", tone: "warning", title: e.title, message: e.message, action: e.action };
  } else if (base.index.pending > 0 || base.sync.scanning) {
    const e = entry("LOCUS-INDEX-001");
    base.banner = { code: "LOCUS-INDEX-001", tone: "info", title: e.title, message: e.message, action: e.action };
  }
  return base;
}
