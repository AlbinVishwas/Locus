import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetLibraryDbForTests } from "@/lib/library/db";
import { FOLDER_MIME } from "@/lib/library/sources/gdriveApi";
import { startMockDrive, type MockDrive } from "@/lib/library/testing/mockDrive";
import { queryActivity } from "@/lib/records/activity";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { _resetAdminCheckForTests, createUserWithGeneratedPasscode } from "@/lib/records/users";
import { _resetUserLimitersForTests } from "@/lib/users/limits";
import { POST as login } from "../login/route";
import { GET as list, POST as add } from "./route";
import { DELETE as remove, PATCH as patch } from "./[id]/route";
import { POST as test } from "./test/route";
import { GET as browse } from "./browse/route";

/**
 * The Sources admin API end to end: who may use it, that Test and Add agree,
 * that paths stay inside the allowed roots, that no password ever comes back
 * out, and that every action leaves a row in the activity log.
 */

const ADMIN = "admin passcode for source tests";
const PASSWORD = "hunter2-very-secret-db-password";
const PDF = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`);

let dir: string;
let roots: string;
let drive: MockDrive | null = null;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function req(url: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (init.cookie) headers.cookie = init.cookie;
  return new Request("http://localhost" + url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function signIn(username: string, passcode: string): Promise<string> {
  const res = await login(req("/api/login", { method: "POST", body: { username, passcode } }));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-sources-api-")));
  roots = path.join(dir, "roots");
  fs.mkdirSync(path.join(roots, "docs", "sub"), { recursive: true });
  fs.writeFileSync(path.join(roots, "docs", "a.pdf"), PDF("a"));
  fs.writeFileSync(path.join(roots, "docs", "sub", "b.pdf"), PDF("b"));
  fs.writeFileSync(path.join(roots, "docs", "notes.txt"), "not a pdf");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  Object.assign(process.env, {
    LOCUS_USERS_ENABLED: "true",
    LOCUS_ADMIN_PASSCODE: ADMIN,
    SESSION_SECRET: "y".repeat(40),
    LOCUS_APP_DB_PATH: path.join(dir, "app", "records.db"),
    LOCUS_LIBRARY_ENABLED: "true",
    LOCUS_DATA_DIR: path.join(dir, "data"),
    LOCUS_ALLOWED_ROOTS: roots,
    LOCUS_SECRETS_KEY: "k".repeat(48),
  });
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  _resetAdminCheckForTests();
  _resetUserLimitersForTests();
});

afterEach(async () => {
  await drive?.close();
  drive = null;
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  for (const k of ["LOCUS_USERS_ENABLED", "LOCUS_ADMIN_PASSCODE", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "LOCUS_LIBRARY_ENABLED", "LOCUS_DATA_DIR", "LOCUS_ALLOWED_ROOTS", "LOCUS_SECRETS_KEY", "GOOGLE_API_KEY", "GOOGLE_DRIVE_API_BASE"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("who can use it", () => {
  it("is closed to users and anonymous callers, and absent when the library is off", async () => {
    const { passcode } = await createUserWithGeneratedPasscode(getRecordsDb(), "alice");
    const alice = await signIn("alice", passcode);
    expect((await list(req("/api/sources", { cookie: alice }))).status).toBe(403);
    expect((await list(req("/api/sources"))).status).toBe(401);
    expect((await add(req("/api/sources", { method: "POST", cookie: alice, body: { kind: "folder", path: path.join(roots, "docs") } }))).status).toBe(403);
    expect((await test(req("/api/sources/test", { method: "POST", cookie: alice, body: { kind: "folder", path: path.join(roots, "docs") } }))).status).toBe(403);
    expect((await browse(req("/api/sources/browse", { cookie: alice }))).status).toBe(403);
    expect((await remove(req("/api/sources/x", { method: "DELETE", cookie: alice }), params("x"))).status).toBe(403);

    const admin = await signIn("admin", ADMIN);
    delete process.env.LOCUS_LIBRARY_ENABLED;
    _resetLibraryDbForTests();
    expect((await list(req("/api/sources", { cookie: admin }))).status).toBe(404);
  });
});

describe("folder sources", () => {
  it("tests, adds, lists, pauses, resumes, rescans, renames and removes", async () => {
    const admin = await signIn("admin", ADMIN);
    const body = { kind: "folder", path: path.join(roots, "docs"), name: "Tenders" };

    const t = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body }))).json()) as { ok: boolean; found: number; message: string; samples: string[] };
    expect(t).toMatchObject({ ok: true, found: 2 });
    expect(t.message).toContain("2 PDFs");
    expect(t.samples.sort()).toEqual(["a.pdf", "sub/b.pdf"]);

    const added = await add(req("/api/sources", { method: "POST", cookie: admin, body }));
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };
    expect((await add(req("/api/sources", { method: "POST", cookie: admin, body: { ...body, name: "tenders" } }))).status).toBe(409);

    const listed = (await (await list(req("/api/sources", { cookie: admin }))).json()) as { sources: Array<{ id: string; name: string; location: string; state: string; status: { kind: string; text: string } }>; allowedRoots: string[] };
    expect(listed.sources).toHaveLength(1);
    expect(listed.sources[0]).toMatchObject({ id, name: "Tenders", state: "active", location: path.join(roots, "docs") });
    expect(listed.sources[0].status.text).toBe("Indexer not running");
    expect(listed.allowedRoots).toEqual([roots]);

    const act = async (action: string, extra: object = {}) => patch(req(`/api/sources/${id}`, { method: "PATCH", cookie: admin, body: { action, ...extra } }), params(id));
    expect((await act("pause")).status).toBe(200);
    const state = async () => ((await (await list(req("/api/sources", { cookie: admin }))).json()) as { sources: Array<{ state: string; name: string; status: { text: string } }> }).sources[0];
    expect((await state()).state).toBe("paused");
    expect((await state()).status.text).toBe("Paused");
    expect((await act("resume")).status).toBe(200);
    expect((await state()).state).toBe("active");
    expect((await act("rescan")).status).toBe(200);
    expect((await act("rename", { name: "BHEL tenders" })).status).toBe(200);
    expect((await state()).name).toBe("BHEL tenders");
    expect((await act("rename", { name: "   " })).status).toBe(400);
    expect((await act("explode")).status).toBe(400);

    const gone = await remove(req(`/api/sources/${id}`, { method: "DELETE", cookie: admin }), params(id));
    expect(gone.status).toBe(200);
    expect((await state()).status.text).toBe("Removing…");
    expect((await act("resume")).status).toBe(400); // can't be brought back
    expect(fs.existsSync(path.join(roots, "docs", "a.pdf"))).toBe(true); // the original files are never touched
    expect((await remove(req("/api/sources/nope", { method: "DELETE", cookie: admin }), params("nope"))).status).toBe(404);

    const kinds = queryActivity(getRecordsDb(), { kinds: ["source_added", "source_tested", "source_paused", "source_resumed", "source_rescan", "source_renamed", "source_removed"] }, { limit: 50 }).rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(["source_added", "source_paused", "source_removed", "source_renamed", "source_rescan", "source_resumed", "source_tested"]);
  });

  it("refuses paths outside the allowed roots, with '..', relative, missing, files, and Locus's own data", async () => {
    const admin = await signIn("admin", ADMIN);
    const bad = async (p: unknown) => (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "folder", path: p } }))).json()) as { ok: boolean; message: string };
    for (const p of [os.homedir(), "/", "/etc", path.join(roots, "..", "data"), path.join(roots, "docs", "..", "..", "etc"), "docs", "", path.join(roots, "missing"), path.join(roots, "docs", "a.pdf"), path.join(dir, "data")]) {
      const r = await bad(p);
      expect(r.ok, String(p)).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
      expect((await add(req("/api/sources", { method: "POST", cookie: admin, body: { kind: "folder", path: p } }))).status, String(p)).toBe(400);
    }
    expect((await bad(os.homedir())).message).toContain("isn't allowed");
  });

  it("refuses a symlink that points out of the allowed roots", async () => {
    const admin = await signIn("admin", ADMIN);
    fs.symlinkSync(os.homedir(), path.join(roots, "escape"));
    const r = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "folder", path: path.join(roots, "escape") } }))).json()) as { ok: boolean };
    expect(r.ok).toBe(false);
  });

  it("counts up to a cap and says 'at least'", async () => {
    const { testSource } = await import("@/lib/library/sources/testSource");
    const { appLibraryConfig } = await import("@/lib/library/sources/appRegistry");
    const r = await testSource({ kind: "folder", path: path.join(roots, "docs") }, appLibraryConfig(), { folderCap: 1 });
    expect(r).toMatchObject({ ok: true, found: 1, atLeast: true });
    expect(r.message).toContain("at least 1 PDF");
  });
});

describe("the folder browser", () => {
  it("starts at the allowed roots, lists only folders, and never leaves them", async () => {
    const admin = await signIn("admin", ADMIN);
    const top = (await (await browse(req("/api/sources/browse", { cookie: admin }))).json()) as { path: string | null; entries: Array<{ name: string; path: string }> };
    expect(top.path).toBeNull();
    expect(top.entries.map((e) => e.path)).toEqual([roots]);

    const inside = (await (await browse(req(`/api/sources/browse?path=${encodeURIComponent(path.join(roots, "docs"))}`, { cookie: admin }))).json()) as { entries: Array<{ name: string }>; parent: string; crumbs: unknown[] };
    expect(inside.entries.map((e) => e.name)).toEqual(["sub"]); // not the files
    expect(inside.parent).toBe(roots);

    for (const p of [os.homedir(), "/", path.join(roots, "..")]) {
      expect((await browse(req(`/api/sources/browse?path=${encodeURIComponent(p)}`, { cookie: admin }))).status, p).toBe(400);
    }
  });
});

describe("database sources", () => {
  function fixture(): string {
    const file = path.join(roots, "docs.sqlite");
    const db = new Database(file);
    db.exec("CREATE TABLE records (rid INTEGER PRIMARY KEY, title TEXT, changed TEXT, location TEXT)");
    const ins = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)");
    ins.run(1, "one.pdf", "2026-01-01T00:00:00Z", path.join(roots, "docs", "a.pdf"));
    ins.run(2, "two.pdf", "2026-01-02T00:00:00Z", path.join(roots, "docs", "sub", "b.pdf"));
    db.close();
    return file;
  }
  const form = (file: string, extra: object = {}) => ({
    kind: "database",
    name: "Records",
    dialect: "sqlite",
    file,
    table: "records",
    columns: { id: "rid", filename: "title", modified: "changed", content: "location" },
    content: "file_path",
    ...extra,
  });

  it("tests a SQLite source with sample rows, then adds it", async () => {
    const admin = await signIn("admin", ADMIN);
    const file = fixture();
    const t = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: form(file) }))).json()) as { ok: boolean; message: string; samples: string[] };
    expect(t.ok).toBe(true);
    expect(t.message).toContain("2 sample rows");
    expect(t.samples).toEqual(["db:1 · one.pdf", "db:2 · two.pdf"]);

    const added = await add(req("/api/sources", { method: "POST", cookie: admin, body: form(file) }));
    expect(added.status).toBe(201);
    const listed = (await (await list(req("/api/sources", { cookie: admin }))).json()) as { sources: Array<{ kind: string; location: string }> };
    expect(listed.sources[0]).toMatchObject({ kind: "database", location: `${file} · records` });
  });

  it("explains a wrong column or table without showing a stack trace", async () => {
    const admin = await signIn("admin", ADMIN);
    const file = fixture();
    const wrongCol = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: form(file, { columns: { id: "rid", filename: "nope", modified: "changed", content: "location" } }) }))).json()) as { ok: boolean; message: string };
    expect(wrongCol.ok).toBe(false);
    expect(wrongCol.message).not.toMatch(/\n\s+at /);
    const wrongTable = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: form(file, { table: "missing" }) }))).json()) as { ok: boolean };
    expect(wrongTable.ok).toBe(false);
  });

  it("rejects identifiers that could carry SQL", async () => {
    const admin = await signIn("admin", ADMIN);
    const file = fixture();
    for (const table of ["records; DROP TABLE records", 'records" --', "a.b.c"]) {
      const r = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: form(file, { table }) }))).json()) as { ok: boolean };
      expect(r.ok, table).toBe(false);
    }
  });

  it("refuses a database file outside the allowed roots", async () => {
    const admin = await signIn("admin", ADMIN);
    const outside = path.join(dir, "data", "x.sqlite");
    new Database(outside).close();
    const r = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: form(outside) }))).json()) as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
  });

  it("seals the password: it never comes back in a response, the list, the activity log or on disk", async () => {
    const admin = await signIn("admin", ADMIN);
    const pg = {
      kind: "database",
      name: "Tender DB",
      connectionString: `postgres://reader:${PASSWORD}@127.0.0.1:1/tenders`,
      table: "documents",
      columns: { id: "id", filename: "name", modified: "updated", content: "path" },
      content: "file_path",
    };
    const t = await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: pg }))).text();
    expect(t).not.toContain(PASSWORD);
    expect(JSON.parse(t).ok).toBe(false); // nothing is listening there

    const added = await add(req("/api/sources", { method: "POST", cookie: admin, body: pg }));
    expect(added.status).toBe(201);
    expect(await added.text()).not.toContain(PASSWORD);
    const listed = await (await list(req("/api/sources", { cookie: admin }))).text();
    expect(listed).not.toContain(PASSWORD);
    expect(listed).toContain("127.0.0.1:1/tenders");
    expect(JSON.stringify(getRecordsDb().prepare("SELECT * FROM activity").all())).not.toContain(PASSWORD);
    for (const f of fs.readdirSync(path.join(dir, "data", "library"))) {
      if (/^sources\.db/.test(f)) expect(fs.readFileSync(path.join(dir, "data", "library", f)).includes(PASSWORD)).toBe(false);
    }
  });

  it("will not save a password without LOCUS_SECRETS_KEY, and says why", async () => {
    delete process.env.LOCUS_SECRETS_KEY;
    const admin = await signIn("admin", ADMIN);
    const r = await add(
      req("/api/sources", { method: "POST", cookie: admin, body: { kind: "database", name: "x", connectionString: `postgres://u:${PASSWORD}@db.internal:5432/d`, table: "t", columns: { id: "a", filename: "b", modified: "c", content: "d" }, content: "file_path" } })
    );
    expect(r.status).toBe(400);
    const text = await r.text();
    expect(text).toContain("LOCUS_SECRETS_KEY");
    expect(text).not.toContain(PASSWORD);
  });

  it("refuses link-local and metadata hosts", async () => {
    const admin = await signIn("admin", ADMIN);
    const r = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "database", name: "x", dialect: "postgres", host: "169.254.169.254", database: "d", table: "t", columns: { id: "a", filename: "b", modified: "c", content: "d" }, content: "file_path" } }))).json()) as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
    expect(r.message).toContain("reserved");
  });
});

describe("Google Drive sources", () => {
  const FOLDER_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
  const tree = () => [
    { id: FOLDER_ID, name: "BHEL tenders", mimeType: FOLDER_MIME, parent: null },
    { id: "f1", name: "one.pdf", parent: FOLDER_ID, content: PDF("one") },
    { id: "f2", name: "two.pdf", parent: FOLDER_ID, content: PDF("two") },
    { id: "x1", name: "notes", mimeType: "application/vnd.google-apps.document", parent: FOLDER_ID },
  ];
  const link = `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`;

  it("tests against the (mocked) Drive API and suggests the folder's name", async () => {
    drive = await startMockDrive(tree());
    Object.assign(process.env, { GOOGLE_API_KEY: drive.apiKey, GOOGLE_DRIVE_API_BASE: drive.base });
    const admin = await signIn("admin", ADMIN);
    const t = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "drive", name: "Drive", link } }))).json()) as { ok: boolean; samples: string[]; folderName: string };
    expect(t).toMatchObject({ ok: true, folderName: "BHEL tenders" });
    expect(t.samples).toEqual(["one.pdf", "two.pdf"]);

    const added = await add(req("/api/sources", { method: "POST", cookie: admin, body: { kind: "drive", name: "BHEL tenders", link } }));
    expect(added.status).toBe(201);
    const listed = (await (await list(req("/api/sources", { cookie: admin }))).json()) as { sources: Array<{ kind: string; location: string }> };
    expect(listed.sources[0]).toMatchObject({ kind: "drive", location: `https://drive.google.com/drive/folders/${FOLDER_ID}` });
  });

  it("says private folders aren't supported yet", async () => {
    drive = await startMockDrive(tree());
    drive.makePrivate(404);
    Object.assign(process.env, { GOOGLE_API_KEY: drive.apiKey, GOOGLE_DRIVE_API_BASE: drive.base });
    const admin = await signIn("admin", ADMIN);
    const t = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "drive", link } }))).json()) as { ok: boolean; message: string };
    expect(t.ok).toBe(false);
    expect(t.message).toContain("Private folders aren't supported yet");
  });

  it("rejects links that aren't a Drive folder, and a server with no API key", async () => {
    const admin = await signIn("admin", ADMIN);
    for (const l of ["", "https://example.com/drive/folders/" + FOLDER_ID, "https://drive.google.com/file/d/abc123456789/view", "not a link"]) {
      const r = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "drive", link: l } }))).json()) as { ok: boolean };
      expect(r.ok, l).toBe(false);
    }
    const noKey = (await (await test(req("/api/sources/test", { method: "POST", cookie: admin, body: { kind: "drive", link } }))).json()) as { ok: boolean; message: string };
    expect(noKey.ok).toBe(false);
    expect(noKey.message).toContain("GOOGLE_API_KEY");
  });
});
