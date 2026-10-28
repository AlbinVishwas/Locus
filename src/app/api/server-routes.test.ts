import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetLibraryDbForTests } from "@/lib/library/db";
import { libraryPaths } from "@/lib/library/config";
import { addRegistrySource, openRegistry } from "@/lib/library/sources/registry";
import { beginDocument, markDocumentReady, openLibraryDb, registerSource, writePages } from "@/lib/library/store";
import { writeMarker } from "@/lib/library/testing/libraryIndex";
import { queryActivity } from "@/lib/records/activity";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { _resetAdminCheckForTests, createUserWithGeneratedPasscode } from "@/lib/records/users";
import { _resetUserLimitersForTests } from "@/lib/users/limits";
import { _resetWritableDbForTests, getWritableDb } from "@/lib/uploads/writableDb";
import { _resetSharedContextForTests } from "@/lib/uploads/pipeline";
import { storedPathFor } from "@/lib/uploads/storage";
import { insertUploadedDocument } from "../../../scripts/indexer/store";
import { POST as login } from "./login/route";
import { GET as serverStatus } from "./server/route";
import { POST as serverTest } from "./server/test/route";
import { POST as serverRescan } from "./server/rescan/route";
import { GET as openLibraryFile } from "./library/file/route";
import { GET as openUpload } from "./uploads/file/route";
import { GET as listUploads, POST as upload } from "./uploads/route";
import { POST as planFolder } from "./folders/route";

/**
 * The storage-server routes and what protects them: who may see the Server page's data, who may open an original PDF
 * (and that nobody else can), the upload limits and the free-disk refusal.
 */

const fakeDisk = vi.hoisted(() => ({ free: null as number | null, total: 2_000_000_000_000 }));
vi.mock("@/lib/server/disk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/disk")>();
  return { ...original, diskInfo: (dir: string) => (fakeDisk.free === null ? original.diskInfo(dir) : { freeBytes: fakeDisk.free, totalBytes: fakeDisk.total }) };
});

const ADMIN = "admin passcode for server route tests";
const GB = 1024 ** 3;
const MB = 1024 ** 2;
let dir: string;
let roots: string;
let server: string;

function req(url: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "localhost", ...init.headers };
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

const PDF_A = Buffer.from("%PDF-1.4 the server's first file, with enough bytes to take a range of");

/** What the indexer would have left: a source in the registry, and one ready document in the library index. */
function indexed(sourceId: string, kind: string, key: string, o: { ownerId?: number | null; folder?: string } = {}) {
  const reg = openRegistry(libraryPaths(path.join(dir, "data")).sources);
  const cfg = kind === "server" ? { type: "folder", label: "Folder x", fingerprint: "f", syncIntervalMin: 10 } : { path: o.folder! };
  addRegistrySource(reg, { id: sourceId, kind: kind as "server" | "folder", name: sourceId, config: cfg as never, managedBy: kind === "server" ? "env" : "app", ownerId: o.ownerId ?? null });
  reg.close();
  const db = openLibraryDb(libraryPaths(path.join(dir, "data")).db);
  registerSource(db, { id: sourceId, kind, label: sourceId, name: sourceId });
  const id = beginDocument(db, { sourceId, key, displayName: key, sizeBytes: 1, modifiedAt: null, sha256: `${sourceId}-${key}`, pageCount: 1, ocrLang: "eng", settings: "x", encryption: null, scanId: 1 });
  writePages(db, id, [{ pageNo: 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: `text of ${key}`, ocrText: null, error: null }]);
  markDocumentReady(db, id);
  db.close();
  return id;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-server-routes-")));
  roots = path.join(dir, "roots");
  server = path.join(dir, "server");
  for (const d of [roots, server, path.join(dir, "data")]) fs.mkdirSync(d, { recursive: true });
  writeMarker(path.join(dir, "data"));
  fakeDisk.free = null;
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
    LOCUS_SERVER_TYPE: "folder",
    LOCUS_SERVER_PATH: server,
    SEARCH_INDEX_PATH: path.join(dir, "index", "search.db"),
    OCR_CACHE_PATH: path.join(dir, "index", "ocr-cache.db"),
    UPLOADS_DIR: path.join(dir, "uploads"),
    LOCUS_ENABLE_UPLOADS: "true",
  });
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  _resetAdminCheckForTests();
  _resetUserLimitersForTests();
});

afterEach(() => {
  _resetWritableDbForTests();
  _resetSharedContextForTests();
  _resetRecordsDbForTests();
  _resetLibraryDbForTests();
  for (const k of ["LOCUS_USERS_ENABLED", "LOCUS_USER_SOURCES", "LOCUS_ADMIN_PASSCODE", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "LOCUS_APP_DIR", "LOCUS_LIBRARY_ENABLED", "LOCUS_DATA_DIR", "LOCUS_ALLOWED_ROOTS", "LOCUS_SERVER_TYPE", "LOCUS_SERVER_PATH", "LOCUS_SERVER_S3_ENDPOINT", "LOCUS_SERVER_S3_BUCKET", "LOCUS_SERVER_S3_ACCESS_KEY", "LOCUS_SERVER_S3_SECRET_KEY", "SEARCH_INDEX_PATH", "OCR_CACHE_PATH", "UPLOADS_DIR", "LOCUS_ENABLE_UPLOADS", "LOCUS_USER_UPLOAD_MB", "LOCUS_MIN_FREE_GB", "STORAGE_CAP_BYTES"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Server page's routes are for the administrator only", () => {
  it("no sign-in: 401. An ordinary account: 403. The administrator: the status, with no secrets in it", async () => {
    Object.assign(process.env, { LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_ENDPOINT: "http://127.0.0.1:1", LOCUS_SERVER_S3_BUCKET: "tenders", LOCUS_SERVER_S3_ACCESS_KEY: "AKIAUNIQUEACCESS123", LOCUS_SERVER_S3_SECRET_KEY: "unique-secret-value-456" });
    const alice = await newUser("alice");
    const admin = await signIn("admin", ADMIN);
    for (const route of [serverStatus, serverTest, serverRescan]) {
      const method = route === serverStatus ? "GET" : "POST";
      expect((await route(req("/api/server", { method }))).status).toBe(401);
      expect((await route(req("/api/server", { method, cookie: alice.cookie }))).status).toBe(403);
    }
    const res = await serverStatus(req("/api/server", { cookie: admin }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ configured: true, type: "s3", label: "S3 bucket tenders on 127.0.0.1:1", syncIntervalMin: 10 });
    expect(text).not.toMatch(/AKIAUNIQUE|unique-secret-value/);
  });

  it("Test connection: a reachable folder says so; a server that isn't there answers with a catalog code and still no secrets", async () => {
    const admin = await signIn("admin", ADMIN);
    const ok = (await (await serverTest(req("/api/server/test", { method: "POST", cookie: admin, body: {} }))).json()) as { ok: boolean; message: string };
    expect(ok).toMatchObject({ ok: true });

    Object.assign(process.env, { LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_ENDPOINT: "http://127.0.0.1:1", LOCUS_SERVER_S3_BUCKET: "b", LOCUS_SERVER_S3_ACCESS_KEY: "AKIAUNIQUEACCESS123", LOCUS_SERVER_S3_SECRET_KEY: "unique-secret-value-456" });
    const bad = await serverTest(req("/api/server/test", { method: "POST", cookie: admin, body: {} }));
    const text = await bad.text();
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: "LOCUS-SERVER-001" });
    expect(text).not.toMatch(/AKIAUNIQUE|unique-secret-value/);

    delete process.env.LOCUS_SERVER_S3_BUCKET; // a settings mistake is reported as such
    const cfg = await serverTest(req("/api/server/test", { method: "POST", cookie: admin, body: {} }));
    expect(cfg.status).toBe(503);
    expect(await cfg.json()).toMatchObject({ code: "LOCUS-SERVER-003" });
  });

  it("Rescan now asks the indexer for a sync", async () => {
    const admin = await signIn("admin", ADMIN);
    indexed("env-server", "server", "a.pdf");
    const res = await serverRescan(req("/api/server/rescan", { method: "POST", cookie: admin, body: {} }));
    expect(res.status).toBe(200);
    const reg = openRegistry(libraryPaths(path.join(dir, "data")).sources);
    expect(reg.prepare("SELECT rescan_requested_at FROM sources WHERE id = 'env-server'").pluck().get()).toEqual(expect.any(String));
    reg.close();
  });
});

describe("opening the original PDF from a search result", () => {
  const open = (doc: number | string, cookie?: string, headers?: Record<string, string>) => openLibraryFile(req(`/api/library/file?doc=${doc}`, { cookie, headers }));

  it("the administrator gets the PDF streamed from the server (a range too), with safe headers and no server path anywhere", async () => {
    fs.writeFileSync(path.join(server, "a.pdf"), PDF_A);
    const doc = indexed("env-server", "server", "a.pdf");
    const admin = await signIn("admin", ADMIN);
    const res = await open(doc, admin);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="a\.pdf"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_A)).toBe(true);
    expect([...res.headers.values()].join(" ")).not.toContain(server);

    const part = await open(doc, admin, { range: "bytes=1-3" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 1-3/${PDF_A.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe("PDF");
    expect((await open(doc, admin, { range: "bytes=9999-" })).status).toBe(416);
  });

  it("not signed in: refused. A document that doesn't exist and one that isn't yours get the very same answer", async () => {
    fs.writeFileSync(path.join(server, "a.pdf"), PDF_A);
    const doc = indexed("env-server", "server", "a.pdf");
    const alice = await newUser("alice");
    expect((await open(doc)).status).toBe(401);
    const notYours = await open(doc, alice.cookie);
    const missing = await open(doc + 999, alice.cookie);
    expect(notYours.status).toBe(404);
    expect(await notYours.json()).toEqual(await missing.json());
    expect((await open("abc", alice.cookie)).status).toBe(404);
    expect((await open("-1", alice.cookie)).status).toBe(404);
  });

  it("an ordinary account opens only documents of folders it owns; another account (demo-user) can't, and the admin can open anyone's", async () => {
    const alice = await newUser("alice");
    const demo = await newUser("demo-user");
    const folder = path.join(roots, "alice-docs");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "mine.pdf"), PDF_A);
    const doc = indexed("alice-src", "folder", "mine.pdf", { ownerId: alice.id, folder });
    // alice's source must also be in the registry under her ownership for the access check; indexed() did that.
    const admin = await signIn("admin", ADMIN);
    expect((await open(doc, alice.cookie)).status).toBe(200);
    expect((await open(doc, demo.cookie)).status).toBe(404);
    expect((await open(doc, admin)).status).toBe(200);
    const kinds = queryActivity(getRecordsDb(), { username: "alice" }, { limit: 20 }).rows.map((r) => r.kind);
    expect(kinds).toContain("open_original");
  });

  it("when LOCUS_USER_SOURCES is off an ordinary account can't open any original", async () => {
    fs.writeFileSync(path.join(server, "a.pdf"), PDF_A);
    const doc = indexed("env-server", "server", "a.pdf");
    const alice = await newUser("alice");
    process.env.LOCUS_USER_SOURCES = "false";
    const res = await open(doc, alice.cookie);
    expect([403, 404]).toContain(res.status);
  });

  it("a file that was removed from the server after it was indexed says so (LOCUS-SERVER-004), not a crash", async () => {
    const doc = indexed("env-server", "server", "gone.pdf");
    const admin = await signIn("admin", ADMIN);
    const res = await open(doc, admin);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "LOCUS-SERVER-004" });
  });

  it("the path comes from the index, never the request: a traversal in the key can't leave the server folder", async () => {
    fs.writeFileSync(path.join(dir, "secret.txt"), "top secret");
    const doc = indexed("env-server", "server", "../secret.txt");
    const admin = await signIn("admin", ADMIN);
    const res = await open(doc, admin);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("top secret");
  });
});

describe("opening a file you uploaded", () => {
  it("only the session's owner gets it; another account is told 'No such session'", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const conv = "conv-privacy-1";
    await listUploads(req(`/api/uploads?conversationId=${conv}`, { cookie: alice.cookie })); // alice claims the session
    const bytes = Buffer.from("%PDF-1.4 alice's uploaded file");
    const sha = "a".repeat(64);
    fs.mkdirSync(path.dirname(storedPathFor(sha)), { recursive: true });
    fs.writeFileSync(storedPathFor(sha), bytes);
    const { docId } = insertUploadedDocument(getWritableDb(), { conversationId: conv, originalFilename: "Alice Tender.pdf", storedFilename: `${sha}.pdf`, sha256: sha, sizeBytes: bytes.length, ocrLang: "eng", settings: "x", uploadedAt: new Date().toISOString(), expiresAt: null, pages: [{ pageNo: 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: "hello world", ocrText: null, error: null }] });
    const get = (cookie?: string, d = docId, c = conv) => openUpload(req(`/api/uploads/file?conversationId=${c}&docId=${d}`, { cookie }));

    const mine = await get(alice.cookie);
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await mine.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await get()).status).toBe(401);
    const theirs = await get(bob.cookie);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toContain("No such session");
    expect((await get(alice.cookie, docId + 50)).status).toBe(404);
    // A real doc id of another session can't be reached through your own session either.
    await listUploads(req(`/api/uploads?conversationId=other-conv`, { cookie: bob.cookie }));
    expect((await get(bob.cookie, docId, "other-conv")).status).toBe(404);
  });
});

describe("upload limits", () => {
  const files = (n: number, sizeMb: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.pdf`, size: sizeMb * MB, sha256: i.toString(16).padStart(64, "0") }));
  const plan = (cookie: string, n: number, sizeMb: number) => planFolder(req("/api/folders", { method: "POST", cookie, body: { name: "big", files: files(n, sizeMb) } }));

  it("the per-account limit is 20 GB by default: a pick declared at 22 GB is refused up front, one at 13 GB is accepted", async () => {
    fakeDisk.free = 1_000 * GB;
    const alice = await newUser("alice");
    const over = await plan(alice.cookie, 250, 90); // 22,500 MB
    expect(over.status).toBe(507);
    const text = await over.text();
    expect(text).toContain("20000 MB upload limit");
    const under = await plan(alice.cookie, 150, 90); // 13,500 MB
    expect(under.status).toBe(200);
    expect(await under.json()).toMatchObject({ total: 150, upload: expect.any(Array) });
  });

  it("LOCUS_USER_UPLOAD_MB changes it", async () => {
    fakeDisk.free = 1_000 * GB;
    process.env.LOCUS_USER_UPLOAD_MB = "1000";
    const alice = await newUser("alice");
    expect((await plan(alice.cookie, 12, 90)).status).toBe(507); // 1,080 MB
    expect((await plan(alice.cookie, 10, 90)).status).toBe(200);
  });

  it("the total cap still applies on top, and is refused before anything is sent", async () => {
    fakeDisk.free = 1_000 * GB;
    process.env.STORAGE_CAP_BYTES = String(5 * GB);
    const alice = await newUser("alice");
    const res = await plan(alice.cookie, 70, 90); // 6,300 MB
    expect(res.status).toBe(507);
    expect(await res.text()).toContain("Storage is full");
  });
});

describe("free disk space is checked before an upload is written", () => {
  it("a folder pick that wouldn't leave the reserve is refused with a clear message (LOCUS-DISK-003); nothing is written", async () => {
    fakeDisk.free = 3 * GB; // less than the 5 GB reserve
    const alice = await newUser("alice");
    const res = await planFolder(req("/api/folders", { method: "POST", cookie: alice.cookie, body: { name: "x", files: [{ path: "a.pdf", size: 50 * MB, sha256: "1".repeat(64) }] } }));
    expect(res.status).toBe(507);
    const body = (await res.json()) as { code: string; message: string; detail: string };
    expect(body.code).toBe("LOCUS-DISK-003");
    expect(body.detail).toMatch(/needs about 100 MB and the disk has 3\.0 GB free, with 5\.0 GB kept in reserve/);
    expect(fs.existsSync(path.join(dir, "uploads"))).toBe(false);
  });

  it("a single upload is refused before it's written, and goes ahead once there's room", async () => {
    const alice = await newUser("alice");
    const form = () => {
      const f = new FormData();
      f.set("conversationId", "conv-disk");
      f.set("file", new File([Buffer.from("%PDF-1.4 tiny")], "a.pdf", { type: "application/pdf" }));
      return new Request("http://localhost/api/uploads", { method: "POST", body: f, headers: { cookie: alice.cookie } });
    };
    fakeDisk.free = 1 * GB;
    const refused = await upload(form());
    expect(refused.status).toBe(507);
    expect(await refused.json()).toMatchObject({ code: "LOCUS-DISK-003" });
    expect(fs.existsSync(path.join(dir, "uploads"))).toBe(false);
    expect(queryActivity(getRecordsDb(), { username: "alice" }, { limit: 20 }).rows.map((r) => r.kind)).not.toContain("upload_ready");

    fakeDisk.free = 500 * GB;
    const accepted = await upload(form());
    expect(accepted.status).toBe(200); // streaming has started (the bytes aren't a real PDF, so it ends in a failed file, not a refusal)
    await accepted.text();
  });

  it("LOCUS_MIN_FREE_GB sets the reserve", async () => {
    fakeDisk.free = 3 * GB;
    process.env.LOCUS_MIN_FREE_GB = "1";
    const alice = await newUser("alice");
    const res = await planFolder(req("/api/folders", { method: "POST", cookie: alice.cookie, body: { name: "x", files: [{ path: "a.pdf", size: 50 * MB, sha256: "1".repeat(64) }] } }));
    expect(res.status).toBe(200);
  });
});
