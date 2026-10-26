import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLibraryConfig } from "../config";
import { buildServedSource } from "./build";
import type { DatabaseConfig } from "./forms";
import { addRegistrySource, getRegistrySource, openRegistry, setSourceSecret } from "./registry";
import type { SourceEntry } from "./types";

let base: string;
let roots: string;
let outside: string;
let dataDir: string;
let registry: Database.Database;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-build-")));
  roots = path.join(base, "Volumes");
  outside = path.join(base, "Secrets");
  dataDir = path.join(base, "data");
  for (const d of [roots, outside, dataDir]) fs.mkdirSync(d);
  registry = openRegistry(path.join(dataDir, "sources.db"));
  process.env.LOCUS_SECRETS_KEY = "build-test-key-build-test-key-1234!";
});

afterEach(() => {
  registry.close();
  delete process.env.LOCUS_SECRETS_KEY;
  fs.rmSync(base, { recursive: true, force: true });
});

const config = () => loadLibraryConfig({ LOCUS_DATA_DIR: dataDir, LOCUS_ALLOWED_ROOTS: roots });
const ctx = (env: Record<string, string | undefined> = {}) => ({ config: config(), registry, env });
const entry = (id: string) => getRegistrySource(registry, id)!;

describe("buildServedSource: folder", () => {
  it("builds a FolderSource keyed by the registry id, named for the admin's name", () => {
    fs.mkdirSync(path.join(roots, "Tenders"));
    const e = addRegistrySource(registry, { kind: "folder", name: "Tenders 2026", config: { path: path.join(roots, "Tenders") } });
    const s = buildServedSource(e, ctx());
    expect(s.error).toBeNull();
    expect(s.source?.id).toBe(e.id);
    expect(s.source?.name).toBe("Tenders 2026");
    expect(s).toMatchObject({ id: e.id, kind: "folder", name: "Tenders 2026", state: "active" });
  });

  it("re-checks the allowed roots every time: a folder that's now outside is an error, not a source", () => {
    const e = addRegistrySource(registry, { kind: "folder", name: "Sneaky", config: { path: outside } });
    const s = buildServedSource(e, ctx());
    expect(s.source).toBeNull();
    expect(s.error).toBe(`The folder is no longer inside an allowed location (${roots}).`);
  });

  it("a folder swapped for a symlink to somewhere else is caught", () => {
    const real = path.join(roots, "Tenders");
    fs.mkdirSync(real);
    const e = addRegistrySource(registry, { kind: "folder", name: "T", config: { path: real } });
    expect(buildServedSource(e, ctx()).error).toBeNull();
    fs.rmSync(real, { recursive: true });
    fs.symlinkSync(outside, real);
    expect(buildServedSource(e, ctx()).error).toMatch(/no longer inside an allowed location/);
  });

  it("a missing folder says to check the drive", () => {
    const e = addRegistrySource(registry, { kind: "folder", name: "Gone", config: { path: path.join(roots, "Gone") } });
    expect(buildServedSource(e, ctx()).error).toBe("The folder wasn't found. If it's on a drive, is the drive connected?");
  });

  it("a folder containing Locus's own data is refused", () => {
    const e = addRegistrySource(registry, { kind: "folder", name: "Everything", config: { path: base } });
    const c = { ...ctx(), config: loadLibraryConfig({ LOCUS_DATA_DIR: dataDir, LOCUS_ALLOWED_ROOTS: base }) };
    expect(buildServedSource(e, c).error).toMatch(/contains Locus's own data folder/);
  });

  it("a folder set in .env is trusted to be where it is (it's the operator's own setting), but not to contain the data folder", () => {
    const e = addRegistrySource(registry, { kind: "folder", name: "From env", config: { path: outside }, managedBy: "env" });
    expect(buildServedSource(e, ctx()).error).toBeNull();
    const e2 = addRegistrySource(registry, { kind: "folder", name: "Env base", config: { path: base }, managedBy: "env" });
    expect(buildServedSource(e2, ctx()).error).toMatch(/contains Locus's own data folder/);
  });
});

describe("buildServedSource: database", () => {
  const pg = (over: Partial<DatabaseConfig> = {}): DatabaseConfig => ({
    dialect: "postgres",
    host: "db.internal",
    port: 5432,
    database: "records",
    user: "reader",
    table: "documents",
    columns: { id: "id", filename: "name", modified: "updated", content: "path" },
    content: "file_path",
    hasPassword: true,
    ...over,
  });

  it("builds a DatabaseSource whose label hides the password, from the sealed secret", () => {
    const e = addRegistrySource(registry, { kind: "database", name: "Records", config: pg(), secret: "s3cret-pw" });
    const s = buildServedSource(e, ctx());
    expect(s.error).toBeNull();
    expect(s.source?.id).toBe(e.id);
    expect(s.label).toBe("database postgres://reader:***@db.internal:5432/records");
    expect(JSON.stringify(s)).not.toContain("s3cret-pw");
  });

  it("explains a password that can't be opened, and one that's missing", () => {
    const e = addRegistrySource(registry, { kind: "database", name: "Records", config: pg(), secret: "pw" });
    process.env.LOCUS_SECRETS_KEY = "a-completely-different-key-of-enough-length";
    expect(buildServedSource(entry(e.id), ctx()).error).toMatch(/Can't read the saved password: This password was saved with a different LOCUS_SECRETS_KEY/);
    process.env.LOCUS_SECRETS_KEY = "build-test-key-build-test-key-1234!";
    const noPw = addRegistrySource(registry, { kind: "database", name: "No pw", config: pg() });
    expect(buildServedSource(noPw, ctx()).error).toBe("The saved password is missing. Edit the source and enter it again.");
  });

  it("a bad identifier or reserved host stored in the registry still can't produce a source", () => {
    const badTable = addRegistrySource(registry, { kind: "database", name: "T", config: pg({ table: 'x"; DROP TABLE y; --', hasPassword: false }) });
    expect(buildServedSource(badTable, ctx()).source).toBeNull();
    const badHost = addRegistrySource(registry, { kind: "database", name: "H", config: pg({ host: "169.254.169.254", hasPassword: false }) });
    expect(buildServedSource(badHost, ctx()).error).toMatch(/reserved/);
  });

  it("sqlite: the file must be inside an allowed root", () => {
    const file = path.join(roots, "docs.db");
    new Database(file).close();
    const ok = addRegistrySource(registry, {
      kind: "database",
      name: "Local",
      config: pg({ dialect: "sqlite", file, host: undefined, hasPassword: false }),
    });
    expect(buildServedSource(ok, ctx()).error).toBeNull();
    const out = path.join(outside, "docs.db");
    new Database(out).close();
    const bad = addRegistrySource(registry, { kind: "database", name: "Out", config: pg({ dialect: "sqlite", file: out, host: undefined, hasPassword: false }) });
    expect(buildServedSource(bad, ctx()).error).toMatch(/Database file: That location isn't allowed/);
  });

  it("a file_path column can only point inside the allowed roots (a row can't aim the indexer at /etc)", async () => {
    const dbFile = path.join(roots, "docs.db");
    const db = new Database(dbFile);
    db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, name TEXT, updated TEXT, path TEXT)");
    fs.writeFileSync(path.join(roots, "ok.pdf"), "%PDF-1.4\n");
    fs.writeFileSync(path.join(outside, "secret.pdf"), "%PDF-1.4\n");
    db.prepare("INSERT INTO documents VALUES (1, 'ok.pdf', '2026-01-01 00:00:00', ?), (2, 'secret.pdf', '2026-01-01 00:00:00', ?), (3, 'passwd', '2026-01-01 00:00:00', '/etc/passwd')").run(
      path.join(roots, "ok.pdf"),
      path.join(outside, "secret.pdf")
    );
    db.close();
    const e = addRegistrySource(registry, {
      kind: "database",
      name: "Paths",
      config: { ...pg({ dialect: "sqlite", file: dbFile, hasPassword: false }), host: undefined },
    });
    const s = buildServedSource(e, ctx());
    expect(s.error).toBeNull();
    const entries: SourceEntry[] = [];
    const skips: Array<{ relPath: string; reason: string }> = [];
    for await (const x of s.source!.scan(new AbortController().signal, (k) => skips.push(k as never))) entries.push(x);
    expect(entries.map((x) => x.displayName)).toEqual(["db:1 · ok.pdf"]);
    expect(skips.map((k) => [k.relPath, k.reason])).toEqual([
      ["db:2 · secret.pdf", "not-allowed"],
      ["db:3 · passwd", "not-allowed"],
    ]);
    await s.source!.close();
  });
});

describe("buildServedSource: Google Drive", () => {
  it("needs GOOGLE_API_KEY; with it, builds a source keyed by the registry id", () => {
    const e = addRegistrySource(registry, { kind: "drive", name: "Shared", config: { folderId: "ABCDEFGHIJKLMNOP", link: "https://drive.google.com/drive/folders/ABCDEFGHIJKLMNOP" } });
    expect(buildServedSource(e, ctx({})).error).toBe("Google Drive isn't set up on this server (GOOGLE_API_KEY is missing).");
    const s = buildServedSource(e, ctx({ GOOGLE_API_KEY: "k" }));
    expect(s.error).toBeNull();
    expect(s.source?.id).toBe(e.id);
    expect(s.kind).toBe("drive");
  });
});

void setSourceSecret;
