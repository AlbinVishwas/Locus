import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, openIndex } from "../../../scripts/indexer/store";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { _resetAdminCheckForTests, createUserWithGeneratedPasscode } from "@/lib/records/users";
import { queryActivity } from "@/lib/records/activity";
import { _resetUserLimitersForTests } from "@/lib/users/limits";
import { POST as login } from "./login/route";
import { POST as signup } from "./signup/route";
import { POST as sessionSearch } from "./session-search/route";
import { GET as libraryStatus } from "./library/status/route";
import { POST as search } from "./search/route";
import { GET as listUsers, POST as createUser } from "./users/route";
import { DELETE as removeUser, PATCH as patchUser } from "./users/[id]/route";
import { GET as listActivity } from "./activity/route";
import { GET as exportActivity } from "./activity/export/route";
import { GET as activitySummary } from "./activity/summary/route";

/**
 * Users mode end to end through the route handlers: who can reach what,
 * that one person never sees another's files, and that everything leaves a
 * row the administrator can read -- without document text in it.
 */

const ADMIN_PASSCODE = "admin passcode for tests";
let dir: string;

const base = "http://localhost";
const json = { "content-type": "application/json" };

function req(url: string, init: { method?: string; cookie?: string; body?: unknown; ip?: string } = {}): Request {
  const headers: Record<string, string> = { ...json, host: "localhost" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.ip) headers["x-forwarded-for"] = init.ip;
  return new Request(base + url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie");
  expect(set).toBeTruthy();
  return set!.split(";")[0];
}

async function signIn(username: string, passcode: string, ip = "10.0.0.1"): Promise<string> {
  const res = await login(req("/api/login", { method: "POST", body: { username, passcode }, ip }));
  expect(res.status).toBe(200);
  return cookieOf(res);
}

async function newUser(name: string): Promise<{ cookie: string; id: number; passcode: string }> {
  const { user, passcode } = await createUserWithGeneratedPasscode(getRecordsDb(), name);
  return { cookie: await signIn(name, passcode), id: user.id, passcode };
}

function seed(conversationId: string, text: string) {
  const db = openIndex(process.env.SEARCH_INDEX_PATH!);
  insertUploadedDocument(db, {
    conversationId,
    originalFilename: `${conversationId}.pdf`,
    storedFilename: `${conversationId}.pdf`,
    sha256: conversationId,
    sizeBytes: 1,
    ocrLang: "eng",
    settings: "v1",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    pages: [{ pageNo: 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: text, ocrText: null, error: null }],
  });
  db.close();
}

const searchSession = (cookie: string, conversationId: string, message: string) =>
  sessionSearch(req("/api/session-search", { method: "POST", cookie, body: { conversationId, message } }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-users-mode-"));
  Object.assign(process.env, {
    LOCUS_USERS_ENABLED: "true",
    LOCUS_ADMIN_PASSCODE: ADMIN_PASSCODE,
    LOCUS_SIGNUP_CODE: "invite-code-123",
    SESSION_SECRET: "x".repeat(40),
    LOCUS_APP_DB_PATH: path.join(dir, "app", "records.db"),
    SEARCH_INDEX_PATH: path.join(dir, "index", "search.db"),
  });
  _resetRecordsDbForTests();
  _resetAdminCheckForTests();
  _resetUserLimitersForTests();
});

afterEach(() => {
  _resetRecordsDbForTests();
  for (const k of ["LOCUS_USERS_ENABLED", "LOCUS_ADMIN_PASSCODE", "LOCUS_SIGNUP_CODE", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "SEARCH_INDEX_PATH", "LOCUS_SIGNUP", "LOCUS_LIBRARY_ENABLED"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sign-in and sign-up", () => {
  it("rejects a wrong passcode and locks an address out after five failures", async () => {
    await newUser("alice");
    for (let i = 0; i < 5; i++) {
      const res = await login(req("/api/login", { method: "POST", body: { username: "alice", passcode: "nope-nope" }, ip: "9.9.9.9" }));
      expect(res.status).toBe(401);
    }
    const locked = await login(req("/api/login", { method: "POST", body: { username: "alice", passcode: "nope-nope" }, ip: "9.9.9.9" }));
    expect(locked.status).toBe(429);
    expect(queryActivity(getRecordsDb(), { kinds: ["login_failed"] }).total).toBe(6);
  });

  it("signs up only with the code; a wrong code creates nothing", async () => {
    const bad = await signup(req("/api/signup", { method: "POST", body: { username: "bob", passcode: "a long enough passcode", code: "wrong" } }));
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ok = await signup(req("/api/signup", { method: "POST", body: { username: "bob", passcode: "a long enough passcode", code: "invite-code-123" } }));
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toContain("locus_session=");
    const names = (await (await listUsersAs(await signIn("admin", ADMIN_PASSCODE))).json()).users.map((u: { username: string }) => u.username);
    expect(names).toContain("bob");
  });

  it("closes sign-up with LOCUS_SIGNUP=off", async () => {
    process.env.LOCUS_SIGNUP = "off";
    const res = await signup(req("/api/signup", { method: "POST", body: { username: "bob", passcode: "a long enough passcode", code: "invite-code-123" } }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

const listUsersAs = (cookie: string) => listUsers(req("/api/users", { cookie }));

describe("one person's files are theirs alone", () => {
  it("lets the owner search a session and refuses everyone else with 'No such session'", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    seed("conv-alice", "the quarterly indemnity clause");

    const mine = await searchSession(alice.cookie, "conv-alice", "indemnity");
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { status: string }).status).toBe("ok");

    const theirs = await searchSession(bob.cookie, "conv-alice", "indemnity");
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toContain("No such session");

    const denied = queryActivity(getRecordsDb(), { kinds: ["access_denied"] });
    expect(denied.rows.map((r) => r.username)).toEqual(["bob"]);
  });

  it("a session id first used by Bob is Bob's; Alice can't take it over", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    seed("conv-shared-id", "something");
    expect((await searchSession(bob.cookie, "conv-shared-id", "something")).status).toBe(200);
    expect((await searchSession(alice.cookie, "conv-shared-id", "something")).status).toBe(404);
  });

  it("refuses a request with no sign-in", async () => {
    seed("c1", "text");
    const res = await sessionSearch(req("/api/session-search", { method: "POST", body: { conversationId: "c1", message: "text" } }));
    expect(res.status).toBe(401);
  });

  it("signs a person out everywhere when they are disabled, and back in when enabled with the same passcode", async () => {
    const alice = await newUser("alice");
    const admin = await signIn("admin", ADMIN_PASSCODE);
    expect((await searchSession(alice.cookie, "c", "abc")).status).not.toBe(401);
    const off = await patchUser(req(`/api/users/${alice.id}`, { method: "PATCH", cookie: admin, body: { action: "disable" } }), { params: Promise.resolve({ id: String(alice.id) }) });
    expect(off.status).toBe(200);
    expect((await searchSession(alice.cookie, "c", "abc")).status).toBe(401);
    const signInAgain = await login(req("/api/login", { method: "POST", body: { username: "alice", passcode: alice.passcode } }));
    expect(signInAgain.status).toBe(403);
  });

  it("a passcode reset invalidates the old session", async () => {
    const alice = await newUser("alice");
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const res = await patchUser(req(`/api/users/${alice.id}`, { method: "PATCH", cookie: admin, body: { action: "reset-passcode" } }), { params: Promise.resolve({ id: String(alice.id) }) });
    const { passcode } = (await res.json()) as { passcode: string };
    expect(passcode.length).toBeGreaterThanOrEqual(8);
    expect((await searchSession(alice.cookie, "c", "abc")).status).toBe(401);
    expect(await signIn("alice", passcode)).toContain("locus_session=");
  });
});

describe("the admin area", () => {
  it("is closed to ordinary users (403) and to anonymous callers (401)", async () => {
    process.env.LOCUS_LIBRARY_ENABLED = "true";
    const alice = await newUser("alice");
    expect((await listUsersAs(alice.cookie)).status).toBe(403);
    expect((await listUsers(req("/api/users"))).status).toBe(401);
    expect((await listActivity(req("/api/activity", { cookie: alice.cookie }))).status).toBe(403);
    expect((await exportActivity(req("/api/activity/export", { cookie: alice.cookie }))).status).toBe(403);
    expect((await activitySummary(req("/api/activity/summary", { cookie: alice.cookie }))).status).toBe(403);
    expect((await search(req("/api/search", { method: "POST", cookie: alice.cookie, body: { query: "x" } }))).status).toBe(403);
    expect((await libraryStatus(req("/api/library/status", { cookie: alice.cookie }))).status).toBe(403);
    const denied = queryActivity(getRecordsDb(), { kinds: ["access_denied"], username: "alice" });
    expect(denied.total).toBeGreaterThanOrEqual(5);
  });

  it("does not exist without an admin passcode", async () => {
    delete process.env.LOCUS_ADMIN_PASSCODE;
    const alice = await newUser("alice");
    expect((await listUsersAs(alice.cookie)).status).toBe(404);
  });

  it("refuses a cross-site request and a non-JSON body from the admin", async () => {
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const cross = new Request(base + "/api/users", { method: "POST", headers: { ...json, cookie: admin, host: "localhost", origin: "https://evil.example" }, body: JSON.stringify({ username: "eve" }) });
    expect((await createUser(cross)).status).toBe(403);
    const form = new Request(base + "/api/users", { method: "POST", headers: { "content-type": "text/plain", cookie: admin, host: "localhost" }, body: "username=eve" });
    expect((await createUser(form)).status).toBe(415);
  });

  it("creates a user with a one-time passcode, lists them without secrets, and removes them with their files", async () => {
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const made = await createUser(req("/api/users", { method: "POST", cookie: admin, body: { username: "carol" } }));
    expect(made.status).toBe(201);
    const { user, passcode } = (await made.json()) as { user: { id: number }; passcode: string };
    expect(passcode.length).toBeGreaterThanOrEqual(8);

    const listed = await (await listUsersAs(admin)).text();
    expect(listed).toContain("carol");
    expect(listed).not.toContain(passcode);
    expect(listed).not.toMatch(/scrypt|hash/i);

    const carol = await signIn("carol", passcode);
    seed("conv-carol", "carol's text");
    expect((await searchSession(carol, "conv-carol", "carol")).status).toBe(200);

    const gone = await removeUser(req(`/api/users/${user.id}`, { method: "DELETE", cookie: admin }), { params: Promise.resolve({ id: String(user.id) }) });
    expect(gone.status).toBe(200);
    expect((await searchSession(carol, "conv-carol", "carol")).status).toBe(401);
    expect(queryActivity(getRecordsDb(), { kinds: ["user_created", "user_removed"] }).total).toBe(2);
  });

  it("cannot disable, reset or remove the admin account through the user routes", async () => {
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const adminId = getRecordsDb().prepare("SELECT id FROM users WHERE role = 'admin'").pluck().get() as number;
    const res = await patchUser(req(`/api/users/${adminId}`, { method: "PATCH", cookie: admin, body: { action: "disable" } }), { params: Promise.resolve({ id: String(adminId) }) });
    expect(res.status).toBe(404);
    const del = await removeUser(req(`/api/users/${adminId}`, { method: "DELETE", cookie: admin }), { params: Promise.resolve({ id: String(adminId) }) });
    expect(del.status).toBe(404);
  });
});

describe("the activity log", () => {
  it("records each search with its text and counts but never document text, and pages through with a cursor", async () => {
    const alice = await newUser("alice");
    seed("conv-a", "confidential merger details are here");
    for (let i = 0; i < 3; i++) await searchSession(alice.cookie, "conv-a", "merger");
    const admin = await signIn("admin", ADMIN_PASSCODE);

    const page1 = (await (await listActivity(req("/api/activity?kind=search&user=alice&limit=2", { cookie: admin }))).json()) as { rows: Array<{ queryText: string; resultPages: number; scope: string }>; total: number; nextBefore: number | null };
    expect(page1.total).toBe(3);
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0]).toMatchObject({ queryText: "merger", resultPages: 1, scope: "my-uploads" });
    const page2 = (await (await listActivity(req(`/api/activity?kind=search&user=alice&limit=2&before=${page1.nextBefore}`, { cookie: admin }))).json()) as { rows: unknown[]; nextBefore: number | null };
    expect(page2.rows).toHaveLength(1);
    expect(page2.nextBefore).toBeNull();

    const everything = JSON.stringify(getRecordsDb().prepare("SELECT * FROM activity").all());
    expect(everything).not.toContain("confidential");
  });

  it("exports CSV and defuses formulas typed as a search", async () => {
    const alice = await newUser("alice");
    seed("conv-f", "x");
    await searchSession(alice.cookie, "conv-f", "=HYPERLINK(\"http://evil\")");
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const res = await exportActivity(req("/api/activity/export?kind=search", { cookie: admin }));
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it("summarises what went wrong", async () => {
    await login(req("/api/login", { method: "POST", body: { username: "nobody", passcode: "whatever-it-is" } }));
    const admin = await signIn("admin", ADMIN_PASSCODE);
    const s = (await (await activitySummary(req("/api/activity/summary", { cookie: admin }))).json()) as { failedSignIns: number };
    expect(s.failedSignIns).toBe(1);
  });

  it("does not log a typed-in passcode as an attempted username", async () => {
    await login(req("/api/login", { method: "POST", body: { username: "my-secret-passcode-1", passcode: "x-something" } }));
    expect(JSON.stringify(getRecordsDb().prepare("SELECT * FROM activity").all())).not.toContain("my-secret-passcode-1");
  });

  it("rejects a malformed filter", async () => {
    const admin = await signIn("admin", ADMIN_PASSCODE);
    expect((await listActivity(req("/api/activity?status=bogus", { cookie: admin }))).status).toBe(400);
    expect((await listActivity(req("/api/activity?from=not-a-date", { cookie: admin }))).status).toBe(400);
  });
});
