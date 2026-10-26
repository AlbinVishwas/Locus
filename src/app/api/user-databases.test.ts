import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetLibraryDbForTests } from "@/lib/library/db";
import { writeMarker } from "@/lib/library/testing/libraryIndex";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { _resetAdminCheckForTests, createUserWithGeneratedPasscode } from "@/lib/records/users";
import { _resetUserLimitersForTests } from "@/lib/users/limits";
import { POST as login } from "./login/route";
import { GET as listSources, POST as addSource } from "./sources/route";
import { POST as testSource } from "./sources/test/route";

/** LOCUS_USER_DATABASES=true (a testing switch): ordinary accounts may add a database as well as folders, never a Drive. */

let dir: string;
let roots: string;

function req(url: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost" };
  if (init.cookie) headers.cookie = init.cookie;
  return new Request("http://localhost" + url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

async function newUser(name: string): Promise<string> {
  const { passcode } = await createUserWithGeneratedPasscode(getRecordsDb(), name);
  const res = await login(req("/api/login", { method: "POST", body: { username: name, passcode } }));
  return res.headers.get("set-cookie")!.split(";")[0];
}

const dbBody = () => ({
  kind: "database",
  name: "My records",
  dialect: "sqlite",
  file: path.join(roots, "records.sqlite"),
  table: "t",
  columns: { id: "a", filename: "b", modified: "c", content: "d" },
  content: "file_path",
});

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-user-dbs-")));
  roots = path.join(dir, "roots");
  fs.mkdirSync(roots, { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  writeMarker(path.join(dir, "data"));
  const db = new Database(path.join(roots, "records.sqlite"));
  db.exec("CREATE TABLE t (a INTEGER, b TEXT, c TEXT, d TEXT)");
  db.close();
  Object.assign(process.env, {
    LOCUS_USERS_ENABLED: "true",
    LOCUS_USER_SOURCES: "true",
    LOCUS_ADMIN_PASSCODE: "admin passcode for user-database tests",
    SESSION_SECRET: "z".repeat(40),
    LOCUS_APP_DB_PATH: path.join(dir, "app", "records.db"),
    LOCUS_APP_DIR: path.join(dir, "app"),
    LOCUS_LIBRARY_ENABLED: "true",
    LOCUS_DATA_DIR: path.join(dir, "data"),
    LOCUS_ALLOWED_ROOTS: roots,
  });
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  _resetAdminCheckForTests();
  _resetUserLimitersForTests();
});

afterEach(() => {
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  for (const k of ["LOCUS_USERS_ENABLED", "LOCUS_USER_SOURCES", "LOCUS_USER_DATABASES", "LOCUS_ADMIN_PASSCODE", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "LOCUS_APP_DIR", "LOCUS_LIBRARY_ENABLED", "LOCUS_DATA_DIR", "LOCUS_ALLOWED_ROOTS"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("user databases", () => {
  it("are refused by default, and the account is told it may add folders only", async () => {
    const cookie = await newUser("alice");
    expect((await addSource(req("/api/sources", { method: "POST", cookie, body: dbBody() }))).status).toBe(403);
    const list = (await (await listSources(req("/api/sources", { cookie }))).json()) as { kinds: string[] };
    expect(list.kinds).toEqual(["folder"]);
  });

  it("are accepted with LOCUS_USER_DATABASES=true, owned by the account, while a Drive stays refused", async () => {
    process.env.LOCUS_USER_DATABASES = "true";
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const tested = await testSource(req("/api/sources/test", { method: "POST", cookie: alice, body: dbBody() }));
    expect(tested.status).toBe(200);
    expect((await addSource(req("/api/sources", { method: "POST", cookie: alice, body: dbBody() }))).status).toBe(201);
    const mine = (await (await listSources(req("/api/sources", { cookie: alice }))).json()) as { kinds: string[]; sources: Array<{ name: string }> };
    expect(mine.kinds).toEqual(["folder", "database"]);
    expect(mine.sources.map((s) => s.name)).toEqual(["My records"]);
    const his = (await (await listSources(req("/api/sources", { cookie: bob }))).json()) as { sources: unknown[] };
    expect(his.sources).toEqual([]);
    const drive = { kind: "drive", name: "x", link: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz" };
    expect((await addSource(req("/api/sources", { method: "POST", cookie: alice, body: drive }))).status).toBe(403);
  });

  it("need LOCUS_USER_SOURCES too", async () => {
    process.env.LOCUS_USER_DATABASES = "true";
    delete process.env.LOCUS_USER_SOURCES;
    const cookie = await newUser("alice");
    expect((await addSource(req("/api/sources", { method: "POST", cookie, body: dbBody() }))).status).toBe(403);
  });
});
