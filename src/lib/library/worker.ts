import { createHash } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { describeServer, serverFingerprint } from "../server/config";
import { SERVER_SOURCE_ID } from "../server/status";
import type { LibraryConfig } from "./config";
import type { ServerSourceConfig } from "./sources/forms";
import type { ServeControl, ServedSource } from "./pipeline";
import { buildServedSource } from "./sources/build";
import {
  addRegistrySource,
  clearRescanRequest,
  deleteRegistrySource,
  listRegistry,
  updateSourceConfig,
  type RegistrySource,
} from "./sources/registry";
import type { LibrarySource } from "./sources/types";

/**
 * The indexer worker's view of the sources registry: on each tick it turns
 * the registry rows into sources (cached, rebuilt only when a row's settings
 * or password change), tells the pipeline when an admin asked for a rescan,
 * and deletes a removed source's row once its index entries are gone.
 */

export interface RegistryControl extends ServeControl {
  close(): Promise<void>;
}

export function createRegistryControl(registry: Database.Database, config: LibraryConfig, env: Record<string, string | undefined> = process.env): RegistryControl {
  const cache = new Map<string, { fingerprint: string; served: ServedSource }>();

  const fingerprint = (e: RegistrySource) => {
    const secretAt = registry.prepare("SELECT updated_at FROM secrets WHERE source_id = ?").pluck().get(e.id) ?? "";
    return JSON.stringify([e.kind, e.name, e.config, e.managedBy, secretAt, env.GOOGLE_API_KEY ? 1 : 0]);
  };

  return {
    async sync() {
      const entries = listRegistry(registry);
      const live = new Set(entries.map((e) => e.id));
      for (const [id, c] of cache) {
        if (!live.has(id)) {
          await c.served.source?.close().catch(() => {});
          cache.delete(id);
        }
      }
      const out: ServedSource[] = [];
      for (const e of entries) {
        const fp = fingerprint(e);
        let c = cache.get(e.id);
        if (!c || c.fingerprint !== fp) {
          await c?.served.source?.close().catch(() => {});
          c = { fingerprint: fp, served: buildServedSource(e, { config, registry, env }) };
          cache.set(e.id, c);
        }
        // State and the rescan request change without rebuilding the source.
        out.push({ ...c.served, state: e.state, rescanRequestedAt: e.rescanRequestedAt, name: e.name });
      }
      return out;
    },
    onRescanStarted(id, requestedAt) {
      clearRescanRequest(registry, id, requestedAt);
    },
    onRemoved(id) {
      deleteRegistrySource(registry, id);
      cache.delete(id);
    },
    async close() {
      for (const c of cache.values()) await (c.served.source as LibrarySource | null)?.close().catch(() => {});
      cache.clear();
    },
  };
}

/**
 * LOCUS_LIBRARY_DIR (set in .env by whoever runs the app) appears in the
 * registry as a source managed in .env: it can be paused, resumed and
 * rescanned from the Sources page but not edited or removed there. A source
 * that was in .env before and no longer is becomes an ordinary one, so it
 * can be removed. (Database sources from .env stay with `npm run
 * index:library`; the Sources page is where database sources are added.)
 */
export function syncEnvSources(registry: Database.Database, config: LibraryConfig): void {
  const keep = new Set<string>();
  // The company storage server (LOCUS_SERVER_*): one source, always named the same, managed in .env.
  if (config.server.type !== "none" || config.serverError) {
    keep.add(SERVER_SOURCE_ID);
    const cfg = config.server;
    const info: ServerSourceConfig =
      cfg.type === "none"
        ? { type: "folder", label: "Storage server (not set up correctly)", fingerprint: "invalid", syncIntervalMin: 10 }
        : { type: cfg.type, label: describeServer(cfg), fingerprint: serverFingerprint(cfg), syncIntervalMin: cfg.syncIntervalMin };
    const existing = listRegistry(registry).find((e) => e.id === SERVER_SOURCE_ID);
    if (!existing) {
      addRegistrySource(registry, { id: SERVER_SOURCE_ID, kind: "server", name: "Company server", config: info, managedBy: "env", createdBy: ".env" });
    } else if (JSON.stringify(existing.config) !== JSON.stringify(info)) {
      updateSourceConfig(registry, SERVER_SOURCE_ID, info);
    }
  }
  if (config.libraryDir) {
    const id = `env-folder-${createHash("sha1").update(config.libraryDir).digest("hex").slice(0, 12)}`;
    keep.add(id);
    const existing = listRegistry(registry).find((e) => e.id === id);
    if (!existing) {
      const base = path.basename(config.libraryDir) || "Library folder";
      const taken = new Set(listRegistry(registry).map((e) => e.name.toLowerCase()));
      const name = taken.has(base.toLowerCase()) ? `${base} (.env)` : base;
      addRegistrySource(registry, { id, kind: "folder", name, config: { path: config.libraryDir }, managedBy: "env", createdBy: ".env" });
    }
  }
  registry.prepare("UPDATE sources SET managed_by = 'app' WHERE managed_by = 'env'" + (keep.size ? ` AND id NOT IN (${[...keep].map(() => "?").join(",")})` : "")).run(...keep);
}
