import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRegistrySource, getRegistrySource, listRegistry, openRegistry } from "./registry";

/** A registry made before the storage server existed has a CHECK that only allows folder / database / drive. */
let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-reg-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function oldRegistry(file: string) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('folder','database','drive')), name TEXT NOT NULL, config TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','removing')),
      managed_by TEXT NOT NULL DEFAULT 'app' CHECK (managed_by IN ('app','env')),
      rescan_requested_at TEXT, created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL, owner_id INTEGER
    );
    CREATE TABLE secrets (source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, blob TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO sources (id, kind, name, config, state, managed_by, created_at, created_by, updated_at, owner_id) VALUES
      ('f1', 'folder', 'Tenders', '{"path":"/Volumes/t"}', 'paused', 'env', '2026-01-01', '.env', '2026-01-02', NULL),
      ('d1', 'drive', 'Shared', '{"folderId":"x","link":"y"}', 'active', 'app', '2026-01-01', 'admin', '2026-01-02', 7);
    INSERT INTO secrets VALUES ('d1', 'sealed-blob', '2026-01-01');
  `);
  db.close();
}

describe("registry migration to allow the storage server kind", () => {
  it("keeps every row, its state, owner and secret, and then accepts a 'server' source", () => {
    const file = path.join(dir, "sources.db");
    oldRegistry(file);
    const db = openRegistry(file);
    expect(listRegistry(db).map((s) => [s.id, s.kind, s.name, s.state, s.managedBy, s.ownerId])).toEqual([
      ["f1", "folder", "Tenders", "paused", "env", null],
      ["d1", "drive", "Shared", "active", "app", 7],
    ]);
    expect(db.prepare("SELECT blob FROM secrets WHERE source_id = 'd1'").pluck().get()).toBe("sealed-blob");

    addRegistrySource(db, { id: "env-server", kind: "server", name: "Company server", config: { type: "folder", label: "Folder /srv", fingerprint: "abc", syncIntervalMin: 10 }, managedBy: "env" });
    expect(getRegistrySource(db, "env-server")).toMatchObject({ kind: "server", managedBy: "env" });
    // Deleting a source still removes its secret (the foreign key survived the rebuild).
    db.prepare("DELETE FROM sources WHERE id = 'd1'").run();
    expect(db.prepare("SELECT count(*) FROM secrets").pluck().get()).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("is a no-op on a registry that already allows it, and on a fresh one", () => {
    const file = path.join(dir, "fresh.db");
    openRegistry(file).close();
    const db = openRegistry(file);
    addRegistrySource(db, { id: "s", kind: "server", name: "S", config: { type: "s3", label: "x", fingerprint: "f", syncIntervalMin: 5 } });
    db.close();
    expect(openRegistry(file).prepare("SELECT count(*) FROM sources").pluck().get()).toBe(1);
  });
});
