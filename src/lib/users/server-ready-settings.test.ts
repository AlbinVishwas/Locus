import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { loadLibraryConfig } from "@/lib/library/config";
import { _resetRecordsDbForTests, getRecordsDb } from "@/lib/records/db";
import { hashPasscode } from "@/lib/records/passcodes";
import { _resetAdminCheckForTests, ensureAdminUser } from "@/lib/records/users";
import { storageCapBytes } from "@/lib/uploads/config";
import { adminEnabled, userUploadLimitBytes } from "./mode";
import { _resetUserLimitersForTests } from "./limits";

const disk = vi.hoisted(() => ({ total: 400 * 1024 ** 3 }));
vi.mock("@/lib/server/disk", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/server/disk")>()), diskInfo: () => ({ freeBytes: disk.total / 2, totalBytes: disk.total }) }));

const GB = 1024 ** 3;

describe("defaults for a laptop", () => {
  afterEach(() => {
    delete process.env.STORAGE_CAP_BYTES;
  });

  it("the per-account upload limit is 20 GB (LOCUS_USER_UPLOAD_MB=20000) unless set", () => {
    expect(userUploadLimitBytes({})).toBe(20_000 * 1024 * 1024);
    expect(userUploadLimitBytes({ LOCUS_USER_UPLOAD_MB: "5000" })).toBe(5000 * 1024 * 1024);
    expect(() => userUploadLimitBytes({ LOCUS_USER_UPLOAD_MB: "-1" })).toThrow(/positive/);
  });

  it("the total cap scales with the disk (half of it, never under 5 GB) unless STORAGE_CAP_BYTES is set", () => {
    disk.total = 400 * GB;
    expect(storageCapBytes()).toBe(200 * GB);
    disk.total = 4 * GB;
    expect(storageCapBytes()).toBe(5 * GB);
    process.env.STORAGE_CAP_BYTES = String(7 * GB);
    expect(storageCapBytes()).toBe(7 * GB);
  });

  it("the free-space reserve is 5 GB once a storage server is connected, 20 GB for the original always-on library, and LOCUS_MIN_FREE_GB wins", () => {
    expect(loadLibraryConfig({}).minFreeBytes).toBe(20 * GB);
    expect(loadLibraryConfig({ LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: "/srv" }).minFreeBytes).toBe(5 * GB);
    expect(loadLibraryConfig({ LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: "/srv", LOCUS_MIN_FREE_GB: "2" }).minFreeBytes).toBe(2 * GB);
  });

  it("smart OCR is the default once a server is connected; the library as it was keeps 'auto'", () => {
    expect(loadLibraryConfig({}).ocrPages).toBe("auto");
    expect(loadLibraryConfig({ LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_BUCKET: "b", LOCUS_SERVER_S3_ACCESS_KEY: "a", LOCUS_SERVER_S3_SECRET_KEY: "s" }).ocrPages).toBe("smart");
    expect(loadLibraryConfig({ LIBRARY_OCR_PAGES: "all" }).ocrPages).toBe("all");
  });

  it("bad server settings don't crash the worker: they're kept as a message for the Server page", () => {
    const c = loadLibraryConfig({ LOCUS_SERVER_TYPE: "folder" });
    expect(c.server).toEqual({ type: "none" });
    expect(c.serverError).toMatch(/LOCUS_SERVER_PATH/);
  });
});

describe("the admin password kept as a hash (what `npm run setup` writes)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-admin-hash-"));
    Object.assign(process.env, { LOCUS_USERS_ENABLED: "true", SESSION_SECRET: "z".repeat(40), LOCUS_APP_DB_PATH: path.join(dir, "records.db"), LOCUS_APP_DIR: dir });
    delete process.env.LOCUS_ADMIN_PASSCODE;
    _resetRecordsDbForTests();
    _resetAdminCheckForTests();
    _resetUserLimitersForTests();
  });
  afterEach(() => {
    _resetRecordsDbForTests();
    for (const k of ["LOCUS_USERS_ENABLED", "SESSION_SECRET", "LOCUS_APP_DB_PATH", "LOCUS_APP_DIR", "LOCUS_ADMIN_PASSCODE", "LOCUS_ADMIN_PASSCODE_HASH"]) delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attempt = (passcode: string) =>
    login(new Request("http://localhost/api/login", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ username: "admin", passcode }) }));

  it("admin sign-in works from the hash alone, with no plain password anywhere", async () => {
    process.env.LOCUS_ADMIN_PASSCODE_HASH = await hashPasscode("correct horse battery");
    expect(adminEnabled()).toBe(true);
    expect((await attempt("wrong password!")).status).toBe(401);
    const ok = await attempt("correct horse battery");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("locus_session=");
    expect(process.env.LOCUS_ADMIN_PASSCODE).toBeUndefined();
    const stored = getRecordsDb().prepare("SELECT passcode_hash FROM users WHERE role = 'admin'").pluck().get() as string;
    expect(stored).toBe(process.env.LOCUS_ADMIN_PASSCODE_HASH);
    expect(stored).toMatch(/^scrypt\$/);
  });

  it("a changed hash signs the old sessions out", async () => {
    process.env.LOCUS_ADMIN_PASSCODE_HASH = await hashPasscode("first password!");
    const before = await ensureAdminUser(getRecordsDb());
    _resetAdminCheckForTests();
    process.env.LOCUS_ADMIN_PASSCODE_HASH = await hashPasscode("second password!");
    const after = await ensureAdminUser(getRecordsDb());
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect((await attempt("first password!")).status).toBe(401);
    expect((await attempt("second password!")).status).toBe(200);
  });

  it("with neither a password nor a hash, admin sign-in is closed", async () => {
    expect(adminEnabled()).toBe(false);
    expect((await attempt("anything at all")).status).toBe(401);
  });

  it("a malformed hash is ignored rather than trusted", () => {
    process.env.LOCUS_ADMIN_PASSCODE_HASH = "not-a-scrypt-hash";
    expect(adminEnabled()).toBe(false);
  });
});
