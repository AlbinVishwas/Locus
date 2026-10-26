import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { SourceConfig, SourceKind } from "./forms";
import { openSecret, sealSecret } from "./secrets";

/**
 * The sources registry: `sources.db` in the library's data folder. The
 * admin APIs in the app write it (add, pause, resume, rescan, remove,
 * rename); the indexer worker reads it every couple of seconds and acts. It
 * holds each source's non-secret settings and desired state -- never
 * progress (the worker records that in the library index, its one writer)
 * and never a password in the clear (sealed in the `secrets` table).
 */

export type SourceState = "active" | "paused" | "removing";
export type ManagedBy = "app" | "env";

export interface RegistrySource {
  id: string;
  kind: SourceKind;
  name: string;
  config: SourceConfig;
  state: SourceState;
  managedBy: ManagedBy;
  rescanRequestedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  /** The account that owns this source (users mode, LOCUS_USER_SOURCES); null = the administrator's / the library's. */
  ownerId: number | null;
  updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('folder','database','drive')),
  name                  TEXT NOT NULL,
  config                TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','removing')),
  managed_by            TEXT NOT NULL DEFAULT 'app' CHECK (managed_by IN ('app','env')),
  rescan_requested_at   TEXT,
  created_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_at            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  source_id   TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  blob        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

export class RegistryError extends Error {
  constructor(
    readonly code: "duplicate-name" | "not-found" | "managed-by-env" | "invalid",
    message: string
  ) {
    super(message);
  }
}

/** Older registries: add the owner column, and make names unique per owner instead of across everyone. */
function migrate(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "owner_id")) db.exec("ALTER TABLE sources ADD COLUMN owner_id INTEGER");
  db.exec("DROP INDEX IF EXISTS sources_name");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sources_owner_name ON sources(coalesce(owner_id, 0), lower(name)) WHERE state != 'removing'");
}

export function openRegistry(file: string, options: { readonly?: boolean } = {}): Database.Database {
  if (options.readonly) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    return db;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

const now = () => new Date().toISOString();

interface Row {
  id: string;
  kind: SourceKind;
  name: string;
  config: string;
  state: SourceState;
  managed_by: ManagedBy;
  rescan_requested_at: string | null;
  created_at: string;
  created_by: string | null;
  owner_id: number | null;
  updated_at: string;
}

function toSource(r: Row): RegistrySource {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: JSON.parse(r.config) as SourceConfig,
    state: r.state,
    managedBy: r.managed_by,
    rescanRequestedAt: r.rescan_requested_at,
    createdAt: r.created_at,
    createdBy: r.created_by,
    ownerId: r.owner_id ?? null,
    updatedAt: r.updated_at,
  };
}

export function listRegistry(db: Database.Database): RegistrySource[] {
  return (db.prepare("SELECT * FROM sources ORDER BY rowid").all() as Row[]).map(toSource);
}

/** The sources one account owns (not the ones being removed). */
export function listOwnedSources(db: Database.Database, ownerId: number): RegistrySource[] {
  return (db.prepare("SELECT * FROM sources WHERE owner_id = ? AND state != 'removing' ORDER BY rowid").all(ownerId) as Row[]).map(toSource);
}

/** An account was removed: its sources go with it (the indexer deletes their index entries). */
export function removeOwnedSources(db: Database.Database, ownerId: number): number {
  return db.prepare("UPDATE sources SET state = 'removing', updated_at = ? WHERE owner_id = ? AND state != 'removing'").run(now(), ownerId).changes;
}

export function getRegistrySource(db: Database.Database, id: string): RegistrySource | null {
  const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Row | undefined;
  return row ? toSource(row) : null;
}

export function addRegistrySource(
  db: Database.Database,
  input: { kind: SourceKind; name: string; config: SourceConfig; secret?: string; managedBy?: ManagedBy; createdBy?: string | null; ownerId?: number | null; id?: string }
): RegistrySource {
  const id = input.id ?? randomUUID();
  // Sealing first: a missing LOCUS_SECRETS_KEY must fail before anything is saved.
  const blob = input.secret !== undefined ? sealSecret(input.secret, id) : null;
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO sources (id, kind, name, config, state, managed_by, created_at, created_by, owner_id, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).run(id, input.kind, input.name, JSON.stringify(input.config), input.managedBy ?? "app", now(), input.createdBy ?? null, input.ownerId ?? null, now());
      if (blob !== null) db.prepare("INSERT INTO secrets (source_id, blob, updated_at) VALUES (?, ?, ?)").run(id, blob, now());
    })();
  } catch (err) {
    if (String((err as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) {
      throw new RegistryError("duplicate-name", "A source with that name already exists.");
    }
    throw err;
  }
  return getRegistrySource(db, id)!;
}

function touch(db: Database.Database, id: string, sql: string, ...params: unknown[]): void {
  const changed = db.prepare(`UPDATE sources SET ${sql}, updated_at = ? WHERE id = ?`).run(...params, now(), id).changes;
  if (changed === 0) throw new RegistryError("not-found", "No such source.");
}

export function setSourceState(db: Database.Database, id: string, state: "active" | "paused" | "removing"): void {
  const source = getRegistrySource(db, id);
  if (!source) throw new RegistryError("not-found", "No such source.");
  if (state === "removing" && source.managedBy === "env") {
    throw new RegistryError("managed-by-env", "This source is set up in .env and can't be removed here. Remove it from .env instead.");
  }
  if (source.state === "removing") return; // removal can't be undone or interrupted
  touch(db, id, "state = ?", state);
}

export function requestRescan(db: Database.Database, id: string): void {
  touch(db, id, "rescan_requested_at = ?", now());
}

/** The worker, once it has started the requested scan. */
export function clearRescanRequest(db: Database.Database, id: string, requestedAt: string): void {
  db.prepare("UPDATE sources SET rescan_requested_at = NULL WHERE id = ? AND rescan_requested_at = ?").run(id, requestedAt);
}

export function renameRegistrySource(db: Database.Database, id: string, name: string): void {
  try {
    touch(db, id, "name = ?", name);
  } catch (err) {
    if (String((err as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) {
      throw new RegistryError("duplicate-name", "A source with that name already exists.");
    }
    throw err;
  }
}

/** The worker, after a removed source's index entries are gone. Also deletes its sealed secret. */
export function deleteRegistrySource(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM sources WHERE id = ?").run(id);
}

export function setSourceSecret(db: Database.Database, id: string, plaintext: string): void {
  if (!getRegistrySource(db, id)) throw new RegistryError("not-found", "No such source.");
  const blob = sealSecret(plaintext, id);
  db.prepare("INSERT INTO secrets (source_id, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at").run(id, blob, now());
}

/** Opens the saved password for a source. Only ever called when a connection is about to be made. */
export function readSourceSecret(db: Database.Database, id: string): string | null {
  const blob = db.prepare("SELECT blob FROM secrets WHERE source_id = ?").pluck().get(id) as string | undefined;
  return blob === undefined ? null : openSecret(blob, id);
}

export function updateSourceConfig(db: Database.Database, id: string, config: SourceConfig): void {
  touch(db, id, "config = ?", JSON.stringify(config));
}
