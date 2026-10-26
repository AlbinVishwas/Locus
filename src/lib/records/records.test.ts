import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityToCsv,
  callerIp,
  csvCell,
  logActivity,
  queryActivity,
  summarizeIssues,
} from "./activity";
import { openRecordsDb, purgeActivity } from "./db";
import { claimConversation, listUploadRecords, markConversationUploadsDeleted, markUploadDeleted, ownerOf, recordUpload } from "./ownership";
import { checkPasscodeStrength, generatePasscode, hashPasscode, verifyPasscode } from "./passcodes";
import {
  _resetAdminCheckForTests,
  adminPasscodeMatches,
  changeOwnPasscode,
  checkUsername,
  createUser,
  createUserWithGeneratedPasscode,
  ensureAdminUser,
  getUser,
  listUsers,
  removeUser,
  resetPasscode,
  setDisabled,
  userUploadBytes,
  verifyLogin,
} from "./users";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-records-"));
  db = openRecordsDb(path.join(dir, "records.db"));
  _resetAdminCheckForTests();
});

afterEach(() => {
  db.close();
  delete process.env.LOCUS_ADMIN_PASSCODE;
  delete process.env.LOCUS_LOG_QUERY_TEXT;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("passcodes", () => {
  it("scrypt-hashes with a per-user salt; only the right passcode verifies; the hash holds nothing readable", async () => {
    const a = await hashPasscode("correct horse battery");
    const b = await hashPasscode("correct horse battery");
    expect(a).not.toBe(b); // salted
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toContain("correct");
    expect(await verifyPasscode("correct horse battery", a)).toBe(true);
    expect(await verifyPasscode("correct horse batterY", a)).toBe(false);
    expect(await verifyPasscode("", a)).toBe(false);
    expect(await verifyPasscode("x", "not-a-hash")).toBe(false);
    expect(await verifyPasscode("x", "scrypt$1$2$3$a$b")).toBe(false);
  });

  it("unicode passcodes verify across equivalent spellings (NFKC)", async () => {
    const h = await hashPasscode("pässwörd-✓-१२३४");
    expect(await verifyPasscode("pässwörd-✓-१२३४", h)).toBe(true);
  });

  it("generated passcodes are 12 characters from an unambiguous alphabet, and different each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePasscode();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it("strength rules", () => {
    expect(checkPasscodeStrength("short", "x").ok).toBe(false);
    expect(checkPasscodeStrength("Password", "x")).toMatchObject({ ok: false });
    expect(checkPasscodeStrength("aaaaaaaaaa", "x")).toMatchObject({ ok: false });
    expect(checkPasscodeStrength("albin.vishwas", "Albin.Vishwas")).toMatchObject({ ok: false, message: expect.stringContaining("same as the username") });
    expect(checkPasscodeStrength("x".repeat(201), "x")).toMatchObject({ ok: false });
    expect(checkPasscodeStrength(undefined)).toMatchObject({ ok: false });
    expect(checkPasscodeStrength("tr0ub4dor&3-ok").ok).toBe(true);
  });
});

describe("accounts", () => {
  it("usernames: 3-32 chars, case-insensitively unique, 'admin' reserved", async () => {
    expect(checkUsername(" albin.v ")).toBe("albin.v");
    for (const bad of ["ab", "a".repeat(33), "-bad", "bad-", "has space", "naïve", "a/b", "<script>", "", null, "Admin", "ADMIN"]) {
      expect(() => checkUsername(bad), String(bad)).toThrow();
    }
    await createUser(db, { username: "Albin", passcode: "a-good-passcode-1", createdBy: "signup" });
    await expect(createUser(db, { username: "albin", passcode: "another-good-one-2", createdBy: "signup" })).rejects.toMatchObject({ code: "taken" });
    await expect(createUser(db, { username: "carol", passcode: "weak", createdBy: "signup" })).rejects.toMatchObject({ code: "weak-passcode" });
  });

  it("sign-in: right passcode works (case-insensitive username); wrong username and wrong passcode look the same; disabled is told only after the right passcode", async () => {
    const u = await createUser(db, { username: "albin", passcode: "a-good-passcode-1", createdBy: "signup" });
    expect(await verifyLogin(db, "ALBIN", "a-good-passcode-1")).toMatchObject({ ok: true, user: { id: u.id, role: "user" } });
    expect(await verifyLogin(db, "albin", "wrong-passcode-1")).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyLogin(db, "nobody", "a-good-passcode-1")).toEqual({ ok: false, reason: "wrong" });
    setDisabled(db, u.id, true);
    expect(await verifyLogin(db, "albin", "wrong-passcode-1")).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyLogin(db, "albin", "a-good-passcode-1")).toEqual({ ok: false, reason: "disabled" });
    setDisabled(db, u.id, false);
    expect((await verifyLogin(db, "albin", "a-good-passcode-1")).ok).toBe(true);
  });

  it("disabling and resetting a passcode bump the token version (signing the user out); enabling doesn't", async () => {
    const u = await createUser(db, { username: "albin", passcode: "a-good-passcode-1", createdBy: "signup" });
    const v0 = u.tokenVersion;
    setDisabled(db, u.id, true);
    const v1 = getUser(db, u.id)!.tokenVersion;
    expect(v1).toBe(v0 + 1);
    setDisabled(db, u.id, false);
    expect(getUser(db, u.id)!.tokenVersion).toBe(v1);
    const fresh = await resetPasscode(db, u.id);
    expect(getUser(db, u.id)!.tokenVersion).toBe(v1 + 1);
    expect((await verifyLogin(db, "albin", "a-good-passcode-1")).ok).toBe(false);
    expect((await verifyLogin(db, "albin", fresh)).ok).toBe(true);
  });

  it("a user changes their own passcode only by knowing the current one", async () => {
    const u = await createUser(db, { username: "albin", passcode: "a-good-passcode-1", createdBy: "signup" });
    await expect(changeOwnPasscode(db, u.id, "not-my-passcode", "brand-new-passcode-3")).rejects.toMatchObject({ code: "wrong-passcode" });
    await expect(changeOwnPasscode(db, u.id, "a-good-passcode-1", "weak")).rejects.toMatchObject({ code: "weak-passcode" });
    const tv = await changeOwnPasscode(db, u.id, "a-good-passcode-1", "brand-new-passcode-3");
    expect(tv).toBe(u.tokenVersion + 1);
    expect((await verifyLogin(db, "albin", "brand-new-passcode-3")).ok).toBe(true);
  });

  it("the admin can create an account with a generated passcode, shown once and not stored in the clear", async () => {
    const { user, passcode } = await createUserWithGeneratedPasscode(db, "dana");
    expect(user).toMatchObject({ username: "dana", createdBy: "admin" });
    expect(JSON.stringify(db.prepare("SELECT * FROM users").all())).not.toContain(passcode);
    expect((await verifyLogin(db, "dana", passcode)).ok).toBe(true);
  });

  it("the built-in admin account: made on first use; a changed LOCUS_ADMIN_PASSCODE signs every admin out; can't log in as a normal user", async () => {
    process.env.LOCUS_ADMIN_PASSCODE = "the-admin-passcode-1";
    const a1 = await ensureAdminUser(db);
    expect(a1).toMatchObject({ username: "admin", role: "admin", createdBy: "env" });
    expect((await ensureAdminUser(db)).tokenVersion).toBe(a1.tokenVersion); // unchanged passcode: stable
    expect(adminPasscodeMatches("the-admin-passcode-1")).toBe(true);
    expect(adminPasscodeMatches("the-admin-passcode-2")).toBe(false);
    expect(adminPasscodeMatches("")).toBe(false);
    expect(await verifyLogin(db, "admin", "the-admin-passcode-1")).toEqual({ ok: false, reason: "wrong" });

    process.env.LOCUS_ADMIN_PASSCODE = "a-new-admin-passcode-9";
    _resetAdminCheckForTests();
    expect((await ensureAdminUser(db)).tokenVersion).toBe(a1.tokenVersion + 1);
    delete process.env.LOCUS_ADMIN_PASSCODE;
    expect(adminPasscodeMatches("anything")).toBe(false);
  });

  it("removing a user returns their sessions and deletes their records, but not the activity history", async () => {
    const u = await createUser(db, { username: "albin", passcode: "a-good-passcode-1", createdBy: "signup" });
    claimConversation(db, "conv-1", u.id);
    claimConversation(db, "conv-2", u.id);
    recordUpload(db, { userId: u.id, conversationId: "conv-1", docId: 1, filename: "a.pdf", sizeBytes: 100, sha256: "x", pageCount: 2, status: "ready" });
    logActivity(db, { userId: u.id, username: "albin", kind: "search", queryText: "ocelot" });
    expect(removeUser(db, u.id).sort()).toEqual(["conv-1", "conv-2"]);
    expect(getUser(db, u.id)).toBeNull();
    expect(ownerOf(db, "conv-1")).toBeNull();
    expect(db.prepare("SELECT count(*) FROM uploads").pluck().get()).toBe(0);
    expect(queryActivity(db, { username: "albin" }).rows).toHaveLength(1); // history stays
    expect(() => removeUser(db, u.id)).toThrow();
  });

  it("the admin account can't be removed or disabled like a user", async () => {
    process.env.LOCUS_ADMIN_PASSCODE = "the-admin-passcode-1";
    const admin = await ensureAdminUser(db);
    expect(() => removeUser(db, admin.id)).toThrowError(expect.objectContaining({ code: "not-found" }));
    expect(() => setDisabled(db, admin.id, true)).toThrowError(expect.objectContaining({ code: "not-found" }));
  });
});

describe("ownership", () => {
  it("the first user to use a session owns it; nobody else can claim it", async () => {
    const a = await createUser(db, { username: "alice", passcode: "alice-passcode-1", createdBy: "signup" });
    const b = await createUser(db, { username: "bobby", passcode: "bobby-passcode-1", createdBy: "signup" });
    expect(claimConversation(db, "c1", a.id)).toBe(a.id);
    expect(claimConversation(db, "c1", b.id)).toBe(a.id); // b is told who owns it, not given it
    expect(claimConversation(db, "c1", a.id)).toBe(a.id);
    expect(ownerOf(db, "c1")).toBe(a.id);
    expect(ownerOf(db, "never-used")).toBeNull();
  });

  it("upload records: counted toward the user's limit while live, kept (marked deleted) after", async () => {
    const a = await createUser(db, { username: "alice", passcode: "alice-passcode-1", createdBy: "signup" });
    recordUpload(db, { userId: a.id, conversationId: "c1", docId: 1, filename: "a.pdf", sizeBytes: 1000, sha256: "s1", pageCount: 3, status: "ready" });
    recordUpload(db, { userId: a.id, conversationId: "c1", docId: 2, filename: "b.pdf", sizeBytes: 500, sha256: "s2", pageCount: 1, status: "ready" });
    recordUpload(db, { userId: a.id, conversationId: "c2", docId: null, filename: "bad.pdf", sizeBytes: 10, sha256: null, pageCount: null, status: "failed", error: "cannot open PDF" });
    expect(userUploadBytes(db, a.id)).toBe(1500); // failed uploads don't count
    markUploadDeleted(db, "c1", 1);
    expect(userUploadBytes(db, a.id)).toBe(500);
    markConversationUploadsDeleted(db, "c1");
    expect(userUploadBytes(db, a.id)).toBe(0);
    const records = listUploadRecords(db, a.id);
    expect(records.map((r) => [r.filename, r.status])).toEqual([["bad.pdf", "failed"], ["b.pdf", "deleted"], ["a.pdf", "deleted"]]);
    expect(records.find((r) => r.filename === "a.pdf")).toMatchObject({ status: "deleted", deletedAt: expect.any(String) });
    expect(listUsers(db)[0]).toMatchObject({ username: "alice", sessions: 0, uploads: 0 });
  });
});

describe("activity log", () => {
  it("records what happened with counts and the query text, and never snippets", () => {
    logActivity(db, { userId: 1, username: "alice", role: "user", kind: "search", scope: "my-uploads", queryText: "earnest money", resultPages: 12, resultDocuments: 3, tookMs: 4.236, ip: "1.2.3.4", userAgent: "Mozilla" });
    const [row] = queryActivity(db, {}).rows;
    expect(row).toMatchObject({ kind: "search", scope: "my-uploads", queryText: "earnest money", resultPages: 12, resultDocuments: 3, tookMs: 4.2, status: "ok", ip: "1.2.3.4", username: "alice" });
    expect(Object.keys(row)).not.toContain("snippet");
  });

  it("LOCUS_LOG_QUERY_TEXT=false keeps everything except the text", () => {
    process.env.LOCUS_LOG_QUERY_TEXT = "false";
    logActivity(db, { userId: 1, username: "alice", kind: "search", queryText: "secret client phrase", resultPages: 1 });
    expect(queryActivity(db, {}).rows[0]).toMatchObject({ queryText: null, resultPages: 1 });
  });

  it("truncates huge text and messages; a broken write never throws", () => {
    logActivity(db, { kind: "search", queryText: "q".repeat(10_000), message: "m".repeat(10_000) });
    const [row] = queryActivity(db, {}).rows;
    expect(row.queryText).toHaveLength(2000);
    expect(row.message).toHaveLength(1000);
    db.close();
    expect(() => logActivity(db, { kind: "search" })).not.toThrow();
    db = openRecordsDb(path.join(dir, "records.db"));
  });

  it("filters: user, event, status, date range, text, and 'issues only'", () => {
    const at = (s: string) => db.prepare("UPDATE activity SET at = ? WHERE id = (SELECT max(id) FROM activity)").run(s);
    logActivity(db, { userId: 1, username: "alice", kind: "search", queryText: "ocelot clause" });
    at("2026-01-01T10:00:00.000Z");
    logActivity(db, { userId: 2, username: "bobby", kind: "search", queryText: "100%_done" });
    at("2026-01-02T10:00:00.000Z");
    logActivity(db, { userId: 2, username: "bobby", kind: "search_failed", status: "error", message: "index unavailable" });
    at("2026-01-03T10:00:00.000Z");
    logActivity(db, { userId: null, username: null, kind: "login_failed", status: "denied", message: "wrong passcode", ip: "9.9.9.9" });
    at("2026-01-04T10:00:00.000Z");
    logActivity(db, { userId: 1, username: "alice", kind: "upload_ready", scope: null });
    at("2026-01-05T10:00:00.000Z");

    const ids = (f: Parameters<typeof queryActivity>[1]) => queryActivity(db, f).rows.map((r) => r.kind);
    expect(ids({})).toEqual(["upload_ready", "login_failed", "search_failed", "search", "search"]); // newest first
    expect(ids({ userId: 2 })).toEqual(["search_failed", "search"]);
    expect(ids({ username: "ALICE" })).toEqual(["upload_ready", "search"]);
    expect(ids({ kinds: ["search"] })).toEqual(["search", "search"]);
    expect(ids({ status: ["denied", "error"] })).toEqual(["login_failed", "search_failed"]);
    expect(ids({ from: "2026-01-02T00:00:00.000Z", to: "2026-01-03T23:59:59.000Z" })).toEqual(["search_failed", "search"]);
    expect(ids({ text: "ocelot" })).toEqual(["search"]);
    expect(ids({ text: "%_" })).toEqual(["search"]); // LIKE wildcards are literal
    expect(ids({ text: "unavailable" })).toEqual(["search_failed"]);
    expect(ids({ issuesOnly: true })).toEqual(["login_failed", "search_failed"]);
    expect(queryActivity(db, { issuesOnly: true }).total).toBe(2);
  });

  it("pages by keyset, newest first, without gaps or repeats even while new rows arrive", () => {
    for (let i = 0; i < 25; i++) logActivity(db, { kind: "search", queryText: `q${i}` });
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const r = queryActivity(db, {}, { limit: 10, before });
      expect(r.total).toBeGreaterThanOrEqual(25);
      seen.push(...r.rows.map((x) => x.queryText!));
      if (page === 0) logActivity(db, { kind: "search", queryText: "arrived-mid-paging" });
      if (r.nextBefore === null) break;
      before = r.nextBefore;
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `q${24 - i}`));
  });

  it("the issues summary counts the last period by problem type", () => {
    logActivity(db, { kind: "login_failed", status: "denied" });
    logActivity(db, { kind: "login_failed", status: "denied" });
    logActivity(db, { kind: "signup_failed", status: "denied" });
    logActivity(db, { kind: "access_denied", status: "denied" });
    logActivity(db, { kind: "search_failed", status: "error" });
    logActivity(db, { kind: "upload_failed", status: "error" });
    logActivity(db, { kind: "indexer_paused", status: "error" });
    logActivity(db, { kind: "search" });
    expect(summarizeIssues(db, "2000-01-01T00:00:00.000Z")).toMatchObject({ failedSignIns: 3, deniedAccess: 1, searchErrors: 1, uploadFailures: 1, storagePauses: 1, indexingProblems: 0 });
    expect(summarizeIssues(db, "2999-01-01T00:00:00.000Z").failedSignIns).toBe(0);
  });

  it("retention purges rows older than the period and keeps the rest", () => {
    logActivity(db, { kind: "search", queryText: "old" });
    db.prepare("UPDATE activity SET at = ?").run(new Date(Date.now() - 400 * 86_400_000).toISOString());
    logActivity(db, { kind: "search", queryText: "recent" });
    expect(purgeActivity(db, 365)).toBe(1);
    expect(queryActivity(db, {}).rows.map((r) => r.queryText)).toEqual(["recent"]);
    expect(purgeActivity(db, 365)).toBe(0);
  });

  it("CSV: quoting, and spreadsheet formulas typed into a search box can't run", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    for (const evil of ["=HYPERLINK(\"http://evil\",\"x\")", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) {
      expect(csvCell(evil).replace(/^"/, "").startsWith("'"), evil).toBe(true);
    }
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
    logActivity(db, { userId: 1, username: "alice", role: "user", kind: "search", queryText: "=1+1", resultPages: 2 });
    const csv = activityToCsv(queryActivity(db, {}).rows);
    expect(csv.split("\r\n")[0]).toBe("time,user,role,event,scope,query,pages,documents,took_ms,status,message,address");
    expect(csv).toContain(",'=1+1,");
  });

  it("caller address: Cloudflare's header first, else the last forwarded entry (the one a proxy added, not one the client chose)", () => {
    expect(callerIp(new Headers({ "cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("5.6.7.8");
    expect(callerIp(new Headers({ "x-forwarded-for": "6.6.6.6, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(callerIp(new Headers())).toBeNull();
  });
});
