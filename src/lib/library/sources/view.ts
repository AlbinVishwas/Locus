import type Database from "better-sqlite3";
import type { DatabaseConfig, DriveConfig, FolderConfig, ServerSourceConfig, SourceKind } from "./forms";
import type { RegistrySource, SourceState } from "./registry";

/**
 * What the Sources page shows: each source from the registry (what the admin
 * asked for) joined with the library index (what the indexer has done), in
 * plain words. Read-only; admin only. Locations are shown to the admin so
 * they can tell sources apart, but never a password.
 */

export type StatusKind = "scanning" | "indexing" | "ready" | "paused" | "removing" | "error" | "waiting" | "limit";

export interface SourceView {
  id: string;
  kind: SourceKind;
  name: string;
  location: string;
  state: SourceState;
  managedBy: "app" | "env";
  /** The account that owns it (shown to the administrator); null for the administrator's own. */
  owner: string | null;
  status: { kind: StatusKind; text: string };
  /** 0..1 while indexing, else null. */
  progress: number | null;
  lastScanAt: string | null;
  documents: number;
  pagesIndexed: number;
  failed: number;
}

export interface WorkerView {
  running: boolean;
  heartbeatAt: string | null;
  state: string | null;
  limit: { kind: "cap" | "reserve"; message: string } | null;
  usedBytes: number | null;
  capBytes: number | null;
  freeBytes: number | null;
  minFreeBytes: number | null;
}

/** The worker publishes every couple of seconds; this long without one means it isn't running. */
export const HEARTBEAT_STALE_MS = 30_000;

export function readWorker(library: Database.Database | null, now = Date.now()): WorkerView {
  const none: WorkerView = { running: false, heartbeatAt: null, state: null, limit: null, usedBytes: null, capBytes: null, freeBytes: null, minFreeBytes: null };
  if (!library) return none;
  let raw: string | undefined;
  try {
    raw = library.prepare("SELECT value FROM meta WHERE key = 'worker_status'").pluck().get() as string | undefined;
  } catch {
    return none;
  }
  if (!raw) return none;
  try {
    const s = JSON.parse(raw) as Partial<WorkerView> & { heartbeatAt?: string };
    const beat = s.heartbeatAt ? Date.parse(s.heartbeatAt) : NaN;
    return {
      running: Number.isFinite(beat) && now - beat < HEARTBEAT_STALE_MS,
      heartbeatAt: s.heartbeatAt ?? null,
      state: s.state ?? null,
      limit: s.limit ?? null,
      usedBytes: s.usedBytes ?? null,
      capBytes: s.capBytes ?? null,
      freeBytes: s.freeBytes ?? null,
      minFreeBytes: s.minFreeBytes ?? null,
    };
  } catch {
    return none;
  }
}

export function locationOf(source: RegistrySource): string {
  switch (source.kind) {
    case "folder":
      return (source.config as FolderConfig).path;
    case "drive":
      return (source.config as DriveConfig).link;
    case "server":
      return (source.config as ServerSourceConfig).label;
    case "database": {
      const c = source.config as DatabaseConfig;
      const table = c.schema ? `${c.schema}.${c.table}` : c.table;
      return c.dialect === "sqlite" ? `${c.file} · ${table}` : `${c.dialect} ${c.host}:${c.port}/${c.database} · ${table}`;
    }
  }
}

interface ScanRow {
  started_at: string;
  finished_at: string | null;
  files_seen: number;
}

export function describeSources(registry: RegistrySource[], library: Database.Database | null, worker: WorkerView, ownerNames?: ReadonlyMap<number, string>): SourceView[] {
  return registry.map((s) => {
    let documents = 0;
    let pagesIndexed = 0;
    let failed = 0;
    let pending = 0;
    let error: string | null = null;
    let lastScanAt: string | null = null;
    let scan: ScanRow | undefined;
    if (library) {
      try {
        const c = library.prepare("SELECT coalesce(sum(status = 'ready'), 0) AS ready, coalesce(sum(status = 'failed'), 0) AS failed, coalesce(sum(pages_done), 0) AS pages FROM documents WHERE source_id = ?").get(s.id) as { ready: number; failed: number; pages: number };
        documents = c.ready;
        failed = c.failed;
        pagesIndexed = c.pages;
        pending = Number(library.prepare("SELECT count(*) FROM jobs WHERE source_id = ? AND state IN ('pending','running')").pluck().get(s.id));
        error = (library.prepare("SELECT last_error FROM sources WHERE id = ?").pluck().get(s.id) as string | null | undefined) ?? null;
        scan = library.prepare("SELECT started_at, finished_at, files_seen FROM scans WHERE source_id = ? ORDER BY id DESC LIMIT 1").get(s.id) as ScanRow | undefined;
        lastScanAt = (library.prepare("SELECT max(finished_at) FROM scans WHERE source_id = ? AND completed = 1").pluck().get(s.id) as string | null) ?? null;
      } catch {
        // the index is being written to or is momentarily unavailable: show what the registry knows
      }
    }
    const n = (v: number) => v.toLocaleString("en-US");
    let status: SourceView["status"];
    if (s.state === "removing") status = { kind: "removing", text: "Removing…" };
    else if (s.state === "paused") status = { kind: "paused", text: "Paused" };
    else if (!worker.running) status = { kind: "waiting", text: "Indexer not running" };
    else if (error) status = { kind: "error", text: `Error: ${error}` };
    else if (worker.limit) status = { kind: "limit", text: worker.limit.kind === "cap" ? "Paused: storage limit reached" : "Paused: low disk space" };
    else if (scan && scan.finished_at === null) status = { kind: "scanning", text: `Scanning… ${n(scan.files_seen)} PDF${scan.files_seen === 1 ? "" : "s"} found so far` };
    else if (pending > 0) status = { kind: "indexing", text: `Indexing… ${n(documents)} of ${n(documents + pending + failed)}` };
    else if (!scan) status = { kind: "waiting", text: "Waiting to scan" };
    else status = { kind: "ready", text: failed > 0 ? `Up to date · ${n(failed)} couldn't be read` : "Up to date" };
    const progress = status.kind === "indexing" ? documents / Math.max(documents + pending + failed, 1) : null;
    return { id: s.id, kind: s.kind, name: s.name, location: locationOf(s), state: s.state, managedBy: s.managedBy, owner: s.ownerId === null || !ownerNames ? null : (ownerNames.get(s.ownerId) ?? "(removed account)"), status, progress, lastScanAt, documents, pagesIndexed, failed };
  });
}
