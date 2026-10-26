import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRegistrySource,
  clearRescanRequest,
  deleteRegistrySource,
  getRegistrySource,
  listRegistry,
  openRegistry,
  readSourceSecret,
  renameRegistrySource,
  requestRescan,
  setSourceSecret,
  setSourceState,
} from "./registry";
import type { DatabaseConfig, FolderConfig } from "./forms";

let dir: string;
let db: Database.Database;
const KEY = "registry-test-key-registry-test-key!";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-registry-"));
  db = openRegistry(path.join(dir, "sources.db"));
  process.env.LOCUS_SECRETS_KEY = KEY;
});

afterEach(() => {
  db.close();
  delete process.env.LOCUS_SECRETS_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

const folder = (p: string): FolderConfig => ({ path: p });
const dbConfig: DatabaseConfig = {
  dialect: "postgres",
  host: "db.internal",
  port: 5432,
  database: "records",
  user: "reader",
  table: "documents",
  columns: { id: "id", filename: "name", modified: "updated", content: "path" },
  content: "file_path",
  hasPassword: true,
};

describe("registry", () => {
  it("adds, lists, and reads back a source; a new source is active", () => {
    const s = addRegistrySource(db, { kind: "folder", name: "Tenders 2026", config: folder("/Volumes/A/Tenders"), createdBy: "admin" });
    expect(s).toMatchObject({ kind: "folder", name: "Tenders 2026", state: "active", managedBy: "app", rescanRequestedAt: null, createdBy: "admin" });
    expect(s.config).toEqual({ path: "/Volumes/A/Tenders" });
    expect(listRegistry(db).map((x) => x.id)).toEqual([s.id]);
    expect(getRegistrySource(db, s.id)).toEqual(s);
    expect(getRegistrySource(db, "nope")).toBeNull();
  });

  it("names are unique ignoring case", () => {
    addRegistrySource(db, { kind: "folder", name: "Tenders", config: folder("/Volumes/A") });
    expect(() => addRegistrySource(db, { kind: "folder", name: "TENDERS", config: folder("/Volumes/B") })).toThrowError(
      expect.objectContaining({ code: "duplicate-name" })
    );
    const b = addRegistrySource(db, { kind: "folder", name: "Other", config: folder("/Volumes/B") });
    expect(() => renameRegistrySource(db, b.id, "tenders")).toThrowError(expect.objectContaining({ code: "duplicate-name" }));
    renameRegistrySource(db, b.id, "Archive");
    expect(getRegistrySource(db, b.id)?.name).toBe("Archive");
  });

  it("pause, resume, rescan: state and the rescan request", () => {
    const s = addRegistrySource(db, { kind: "folder", name: "A", config: folder("/Volumes/A") });
    setSourceState(db, s.id, "paused");
    expect(getRegistrySource(db, s.id)?.state).toBe("paused");
    setSourceState(db, s.id, "active");
    expect(getRegistrySource(db, s.id)?.state).toBe("active");
    requestRescan(db, s.id);
    const requested = getRegistrySource(db, s.id)!.rescanRequestedAt;
    expect(requested).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The worker clears only the request it acted on, not a newer one.
    clearRescanRequest(db, s.id, "2000-01-01T00:00:00.000Z");
    expect(getRegistrySource(db, s.id)?.rescanRequestedAt).toBe(requested);
    clearRescanRequest(db, s.id, requested!);
    expect(getRegistrySource(db, s.id)?.rescanRequestedAt).toBeNull();
    expect(() => setSourceState(db, "nope", "paused")).toThrowError(expect.objectContaining({ code: "not-found" }));
  });

  it("removing is one-way, and a removed source's name can be reused while it is being cleaned up", () => {
    const s = addRegistrySource(db, { kind: "folder", name: "A", config: folder("/Volumes/A") });
    setSourceState(db, s.id, "removing");
    setSourceState(db, s.id, "active"); // ignored: removal can't be interrupted
    expect(getRegistrySource(db, s.id)?.state).toBe("removing");
    addRegistrySource(db, { kind: "folder", name: "A", config: folder("/Volumes/B") });
    deleteRegistrySource(db, s.id);
    expect(getRegistrySource(db, s.id)).toBeNull();
  });

  it("a source managed in .env can be paused and rescanned but not removed", () => {
    const s = addRegistrySource(db, { kind: "folder", name: "From env", config: folder("/Volumes/E"), managedBy: "env" });
    setSourceState(db, s.id, "paused");
    expect(() => setSourceState(db, s.id, "removing")).toThrowError(expect.objectContaining({ code: "managed-by-env" }));
  });

  it("secrets: sealed at rest, opened on request, replaced, and deleted with the source", () => {
    const s = addRegistrySource(db, { kind: "database", name: "Records", config: dbConfig, secret: "s3cret-passw0rd" });
    const stored = db.prepare("SELECT blob FROM secrets WHERE source_id = ?").pluck().get(s.id) as string;
    expect(stored).not.toContain("s3cret");
    expect(JSON.stringify(db.prepare("SELECT * FROM sources").all())).not.toContain("s3cret");
    expect(readSourceSecret(db, s.id)).toBe("s3cret-passw0rd");
    setSourceSecret(db, s.id, "new-password-123");
    expect(readSourceSecret(db, s.id)).toBe("new-password-123");
    deleteRegistrySource(db, s.id);
    expect(db.prepare("SELECT count(*) FROM secrets").pluck().get()).toBe(0);
    expect(readSourceSecret(db, s.id)).toBeNull();
  });

  it("with no LOCUS_SECRETS_KEY a password can't be saved -- and nothing is half-saved", () => {
    delete process.env.LOCUS_SECRETS_KEY;
    expect(() => addRegistrySource(db, { kind: "database", name: "Records", config: dbConfig, secret: "pw" })).toThrowError(
      expect.objectContaining({ code: "no-key" })
    );
    expect(listRegistry(db)).toEqual([]);
    // A source with no secret needs no key.
    addRegistrySource(db, { kind: "folder", name: "A", config: folder("/Volumes/A") });
  });

  it("a password sealed for one source doesn't open for another (even if the rows are swapped by hand)", () => {
    const a = addRegistrySource(db, { kind: "database", name: "A", config: dbConfig, secret: "pw-a" });
    const b = addRegistrySource(db, { kind: "database", name: "B", config: dbConfig, secret: "pw-b" });
    const blobA = db.prepare("SELECT blob FROM secrets WHERE source_id = ?").pluck().get(a.id) as string;
    db.prepare("UPDATE secrets SET blob = ? WHERE source_id = ?").run(blobA, b.id);
    expect(() => readSourceSecret(db, b.id)).toThrowError(expect.objectContaining({ code: "tampered" }));
  });

  it("the worker can read the registry read-only", () => {
    addRegistrySource(db, { kind: "folder", name: "A", config: folder("/Volumes/A") });
    const ro = openRegistry(path.join(dir, "sources.db"), { readonly: true });
    expect(listRegistry(ro)).toHaveLength(1);
    expect(() => ro.prepare("DELETE FROM sources").run()).toThrow();
    ro.close();
  });
});
