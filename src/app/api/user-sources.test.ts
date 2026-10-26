import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetLibraryDbForTests } from "@/lib/library/db";
import { libraryPaths } from "@/lib/library/config";
import { addRegistrySource, getRegistrySource, openRegistry } from "@/lib/library/sources/registry";
import { beginDocument, markDocumentReady, openLibraryDb, registerSource, writePages } from "@/lib/library/store";
import { writeMarker } from "@/lib/library/testing/libraryIndex";
import { queryActivity } from "@/lib/records/activity";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { _resetAdminCheckForTests, createUserWithGeneratedPasscode } from "@/lib/records/users";
import { _resetUserLimitersForTests } from "@/lib/users/limits";
import { POST as login } from "./login/route";
import { GET as listSources, POST as addSource } from "./sources/route";
import { DELETE as removeSource, PATCH as patchSource } from "./sources/[id]/route";
import { POST as testSource } from "./sources/test/route";
import { GET as browse } from "./sources/browse/route";
import { POST as librarySearch } from "./library/search/route";
import { GET as libraryStatus } from "./library/status/route";
import { DELETE as removeUser } from "./users/[id]/route";
import { proxy } from "@/proxy";
import { NextRequest } from "next/server";

/**
 * LOCUS_USER_SOURCES=true: ordinary accounts add and search their own folders.
 * What matters: a person's folders are theirs alone (listing, changing, removing,
 * searching, counts), they can add folders and nothing else, they are limited
 * in number, and with the setting off none of it exists.
 */

const ADMIN = "admin passcode for user-folder tests";
let dir: string;
let roots: string;
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

async function newUser(name: string) {
  const { user, passcode } = await createUserWithGeneratedPasscode(getRecordsDb(), name);
  return { id: user.id, cookie: await signIn(name, passcode) };
}

const folderBody = (name: string, folder: string) => ({ kind: "folder", name, path: path.join(roots, folder) });

/** What the indexer would have done for a source: register it in the library index and index one document saying `text`. */
function index(sourceId: string, name: string, text: string) {
  const db = openLibraryDb(libraryPaths(path.join(dir, "data")).db);
  registerSource(db, { id: sourceId, kind: "folder", label: `folder ${name}`, name });
  const id = beginDocument(db, { sourceId, key: `${name}.pdf`, displayName: `${name}.pdf`, sizeBytes: 1, modifiedAt: null, sha256: sourceId, pageCount: 1, ocrLang: "eng", settings: "x", encryption: null, scanId: 1 });
  writePages(db, id, [{ pageNo: 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: text, ocrText: null, error: null }]);
  markDocumentReady(db, id);
  db.close();
}

const search = (cookie: string, body: object) => librarySearch(req("/api/library/search", { method: "POST", cookie, body }));
const pagesFound = async (res: Response) => {
  const j = (await res.json()) as { status: string; result?: { counts: { pages: number } | null; hits: Array<{ sourceName: string }> } };
  return { status: j.status, pages: j.result?.counts?.pages ?? 0, sources: new Set((j.result?.hits ?? []).map((h) => h.sourceName)) };
};

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-user-sources-")));
  roots = path.join(dir, "roots");
  for (const f of ["alice-docs", "bob-docs", "admin-docs"]) fs.mkdirSync(path.join(roots, f), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  writeMarker(path.join(dir, "data"));
  Object.assign(process.env, {
    LOCUS_USERS_ENABLED: "true",
    LOCUS_USER_SOURCES: "true",
    LOCUS_ADMIN_PASSCODE: ADMIN,
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
  for (const k of ["LOCUS_USERS_ENABLED", "LOCUS_USER_SOURCES", "LOCUS_USER_SOURCES_MAX", "LOCUS_ADMIN_PASSCODE", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "LOCUS_APP_DIR", "LOCUS_LIBRARY_ENABLED", "LOCUS_DATA_DIR", "LOCUS_ALLOWED_ROOTS"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("with LOCUS_USER_SOURCES on", () => {
  it("an ordinary account adds, lists, tests, renames, pauses and removes its own folder", async () => {
    const alice = await newUser("alice");
    const t = (await (await testSource(req("/api/sources/test", { method: "POST", cookie: alice.cookie, body: folderBody("Tenders", "alice-docs") }))).json()) as { ok: boolean };
    expect(t.ok).toBe(true);
    const added = await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("Tenders", "alice-docs") }));
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };

    const listed = (await (await listSources(req("/api/sources", { cookie: alice.cookie }))).json()) as { sources: Array<{ id: string; name: string; owner: string | null }>; scope: string; maxSources: number; capBytes: number; worker: { usedBytes: number | null } };
    expect(listed.scope).toBe("mine");
    expect(listed.sources.map((s) => s.name)).toEqual(["Tenders"]);
    expect(listed.maxSources).toBe(5);
    // Nothing about the library's size or the machine's disk is told to an ordinary account.
    expect(listed.capBytes).toBe(0);
    expect(listed.worker.usedBytes).toBeNull();

    const act = (action: string, extra: object = {}) => patchSource(req(`/api/sources/${id}`, { method: "PATCH", cookie: alice.cookie, body: { action, ...extra } }), params(id));
    expect((await act("pause")).status).toBe(200);
    expect((await act("resume")).status).toBe(200);
    expect((await act("rename", { name: "BHEL" })).status).toBe(200);
    expect((await removeSource(req(`/api/sources/${id}`, { method: "DELETE", cookie: alice.cookie }), params(id))).status).toBe(200);
    const kinds = queryActivity(getRecordsDb(), { username: "alice" }, { limit: 50 }).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["source_added", "source_paused", "source_resumed", "source_renamed", "source_removed"]));
  });

  it("can add folders and nothing else", async () => {
    const alice = await newUser("alice");
    for (const body of [
      { kind: "database", name: "x", dialect: "sqlite", file: path.join(roots, "x.sqlite"), table: "t", columns: { id: "a", filename: "b", modified: "c", content: "d" }, content: "file_path" },
      { kind: "drive", name: "x", link: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz" },
    ]) {
      expect((await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body }))).status).toBe(403);
      expect((await testSource(req("/api/sources/test", { method: "POST", cookie: alice.cookie, body }))).status).toBe(403);
    }
  });

  it("keeps to the allowed locations, and away from accounts, uploads and the search index", async () => {
    const alice = await newUser("alice");
    for (const p of [os.homedir(), "/", "/etc", path.join(roots, "..")]) {
      expect((await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: { kind: "folder", path: p } }))).status, p).toBe(400);
    }
    // Even if an allowed root were set so wide that it covers Locus's own files:
    process.env.LOCUS_ALLOWED_ROOTS = dir;
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    const own = await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: { kind: "folder", path: path.join(dir, "app") } }));
    expect(own.status).toBe(400);
    expect(await own.text()).toContain("Locus's own files");
    const wide = await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: { kind: "folder", path: dir } }));
    expect(wide.status).toBe(400); // it contains the data folder and the app folder
  });

  it("limits how many folders one account may add", async () => {
    process.env.LOCUS_USER_SOURCES_MAX = "2";
    const alice = await newUser("alice");
    for (const n of ["a", "b"]) {
      fs.mkdirSync(path.join(roots, n), { recursive: true });
      expect((await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody(n, n) }))).status).toBe(201);
    }
    fs.mkdirSync(path.join(roots, "c"), { recursive: true });
    const third = await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("c", "c") }));
    expect(third.status).toBe(409);
    expect(await third.text()).toContain("up to 2 folders");
  });

  it("one account's folders are invisible and untouchable to another, and names may repeat across accounts", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const a = (await (await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("Tenders", "alice-docs") }))).json()) as { id: string };
    expect((await addSource(req("/api/sources", { method: "POST", cookie: bob.cookie, body: folderBody("Tenders", "bob-docs") }))).status).toBe(201); // same name, different owner
    expect((await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("tenders", "bob-docs") }))).status).toBe(409); // same owner: no

    const bobsList = (await (await listSources(req("/api/sources", { cookie: bob.cookie }))).json()) as { sources: Array<{ id: string }> };
    expect(bobsList.sources.map((s) => s.id)).not.toContain(a.id);
    for (const [method, body] of [["PATCH", { action: "pause" }], ["DELETE", undefined]] as const) {
      const fn = method === "PATCH" ? patchSource : removeSource;
      const res = await fn(req(`/api/sources/${a.id}`, { method, cookie: bob.cookie, body }), params(a.id));
      expect(res.status, method).toBe(404);
    }
    expect(getRegistrySource(openRegistry(libraryPaths(path.join(dir, "data")).sources), a.id)?.state).toBe("active");
  });

  it("an account searches only its own folders, with counts of its own, and never sees another's hits", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const a = (await (await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("Alice tenders", "alice-docs") }))).json()) as { id: string };
    const b = (await (await addSource(req("/api/sources", { method: "POST", cookie: bob.cookie, body: folderBody("Bob contracts", "bob-docs") }))).json()) as { id: string };
    const admin = openRegistry(libraryPaths(path.join(dir, "data")).sources);
    const adminSource = addRegistrySource(admin, { kind: "folder", name: "Library", config: { path: path.join(roots, "admin-docs") } });
    index(a.id, "Alice tenders", "The shared phrase and the alice only phrase.");
    index(b.id, "Bob contracts", "The shared phrase and the bob only phrase.");
    index(adminSource.id, "Library", "The shared phrase and the library only phrase.");

    const al = await pagesFound(await search(alice.cookie, { message: "shared phrase" }));
    expect(al).toMatchObject({ status: "ok", pages: 1 });
    expect([...al.sources]).toEqual(["Alice tenders"]);
    expect((await pagesFound(await search(alice.cookie, { message: "bob only phrase" }))).pages).toBe(0);
    expect((await pagesFound(await search(alice.cookie, { message: "library only phrase" }))).pages).toBe(0);
    expect((await pagesFound(await search(bob.cookie, { message: "alice only phrase" }))).pages).toBe(0);

    // Naming someone else's folder (or the library's) finds nothing: the same answer as for one that doesn't exist.
    expect((await pagesFound(await search(alice.cookie, { message: "shared phrase", source: b.id }))).pages).toBe(0);
    expect((await pagesFound(await search(alice.cookie, { message: "shared phrase", source: adminSource.id }))).pages).toBe(0);
    expect((await pagesFound(await search(alice.cookie, { message: "shared phrase", source: a.id }))).pages).toBe(1);
    expect((await pagesFound(await search(alice.cookie, { message: "shared phrase", source: "nonsense" }))).pages).toBe(0);

    // Paging asks the same question again and stays inside her folders.
    const page = await pagesFound(await search(alice.cookie, { query: "shared phrase", mode: "exact", cursor: 0 }));
    expect([...page.sources]).toEqual(["Alice tenders"]);

    // Status counts are hers alone, and list only her folders.
    const st = (await (await libraryStatus(req("/api/library/status", { cookie: alice.cookie }))).json()) as { documents: number; sources?: Array<{ name: string }>; storage?: unknown };
    expect(st.documents).toBe(1);
    expect(st.sources?.map((s) => s.name)).toEqual(["Alice tenders"]);
    expect(st.storage).toBeUndefined();

    // The administrator searches everything.
    const adminCookie = await signIn("admin", ADMIN);
    const all = await pagesFound(await search(adminCookie, { message: "shared phrase" }));
    expect(all.pages).toBe(3);
    const adminList = (await (await listSources(req("/api/sources", { cookie: adminCookie }))).json()) as { sources: Array<{ name: string; owner: string | null }> };
    expect(adminList.sources.map((s) => [s.name, s.owner])).toEqual([["Alice tenders", "alice"], ["Bob contracts", "bob"], ["Library", null]]);

    // Her searches are in the activity log, scoped to her folders.
    const rows = queryActivity(getRecordsDb(), { username: "alice", kinds: ["search"] }, { limit: 20 }).rows;
    expect(rows.some((r) => r.scope === "my-folders")).toBe(true);
    expect(rows.some((r) => r.scope === "source:Alice tenders")).toBe(true);
  });

  it("an account with no folders finds nothing and learns nothing", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const b = (await (await addSource(req("/api/sources", { method: "POST", cookie: bob.cookie, body: folderBody("Bob contracts", "bob-docs") }))).json()) as { id: string };
    index(b.id, "Bob contracts", "A secret phrase.");
    expect((await pagesFound(await search(alice.cookie, { message: "secret phrase" }))).pages).toBe(0);
    const st = (await (await libraryStatus(req("/api/library/status", { cookie: alice.cookie }))).json()) as { documents: number; sources?: unknown };
    expect(st.documents).toBe(0);
    expect(st.sources).toBeUndefined();
  });

  it("the folder browser is open to them, inside the allowed locations only", async () => {
    const alice = await newUser("alice");
    const top = (await (await browse(req("/api/sources/browse", { cookie: alice.cookie }))).json()) as { entries: Array<{ path: string }> };
    expect(top.entries.map((e) => e.path)).toEqual([roots]);
    expect((await browse(req(`/api/sources/browse?path=${encodeURIComponent(os.homedir())}`, { cookie: alice.cookie }))).status).toBe(400);
  });

  it("removing an account removes its folders (the originals are untouched)", async () => {
    const alice = await newUser("alice");
    fs.writeFileSync(path.join(roots, "alice-docs", "a.pdf"), "%PDF-1.4");
    await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("Tenders", "alice-docs") }));
    const adminCookie = await signIn("admin", ADMIN);
    const del = await removeUser(req(`/api/users/${alice.id}`, { method: "DELETE", cookie: adminCookie }), params(String(alice.id)));
    expect(del.status).toBe(200);
    const sources = openRegistry(libraryPaths(path.join(dir, "data")).sources);
    expect((sources.prepare("SELECT state FROM sources").pluck().all() as string[])).toEqual(["removing"]);
    expect(fs.existsSync(path.join(roots, "alice-docs", "a.pdf"))).toBe(true);
  });

  it("the proxy lets an ordinary account reach /sources and /api/sources, but still not Users, Activity or the old /api/search", async () => {
    const alice = await newUser("alice");
    const call = async (p: string) => {
      const r = await proxy(new NextRequest(`http://localhost${p}`, { headers: { cookie: alice.cookie } }));
      return r.status;
    };
    expect(await call("/sources")).toBe(200);
    expect(await call("/api/sources")).toBe(200);
    expect(await call("/api/library/status")).toBe(200);
    expect(await call("/users")).toBe(307);
    expect(await call("/api/users")).toBe(403);
    expect(await call("/api/activity")).toBe(403);
    expect(await call("/api/search")).toBe(403);
  });
});

describe("with LOCUS_USER_SOURCES off (the default)", () => {
  it("an ordinary account has none of it, as before", async () => {
    delete process.env.LOCUS_USER_SOURCES;
    const alice = await newUser("alice");
    expect((await listSources(req("/api/sources", { cookie: alice.cookie }))).status).toBe(403);
    expect((await addSource(req("/api/sources", { method: "POST", cookie: alice.cookie, body: folderBody("T", "alice-docs") }))).status).toBe(403);
    expect((await search(alice.cookie, { message: "anything" })).status).toBe(403);
    expect((await libraryStatus(req("/api/library/status", { cookie: alice.cookie }))).status).toBe(403);
    const r = await proxy(new NextRequest("http://localhost/api/sources", { headers: { cookie: alice.cookie } }));
    expect(r.status).toBe(403);
  });
});
