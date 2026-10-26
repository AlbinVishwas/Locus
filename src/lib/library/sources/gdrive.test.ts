import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_MIME } from "./gdriveApi";
import { DEFAULT_DRIVE_BASE, DriveApi, DriveError, driveApiBase } from "./gdriveApi";
import { GoogleDriveSource } from "./gdrive";
import { canonicalFolderLink, parseDriveLink } from "./gdriveLink";
import { SourceFileError, type SourceEntry } from "./types";
import { md5Of, startMockDrive, type MockDrive, type MockFile } from "../testing/mockDrive";

const PDF = (s: string) => Buffer.from(`%PDF-1.4\n${s}\n%%EOF\n`);
const ROOT = "ROOTFOLDERID0000001";
let drive: MockDrive | null = null;
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locus-gdrive-"));
});

afterEach(async () => {
  await drive?.close();
  drive = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const tree = (): MockFile[] => [
  { id: ROOT, name: "BHEL tenders", mimeType: FOLDER_MIME, parent: null },
  { id: "f1", name: "a-notice.pdf", parent: ROOT, content: PDF("one"), modifiedTime: "2026-02-01T10:00:00.000Z" },
  { id: "f2", name: "b-spec.pdf", parent: ROOT, content: PDF("two") },
  { id: "d1", name: "2025", mimeType: FOLDER_MIME, parent: ROOT },
  { id: "f3", name: "old.pdf", parent: "d1", content: PDF("three") },
  { id: "d2", name: "deeper", mimeType: FOLDER_MIME, parent: "d1" },
  { id: "f4", name: "deep.pdf", parent: "d2", content: PDF("four") },
  { id: "x1", name: "notes", mimeType: "application/vnd.google-apps.document", parent: ROOT },
  { id: "x2", name: "photo.jpg", mimeType: "image/jpeg", parent: ROOT, content: Buffer.from("jpg") },
];

const api = (d: MockDrive, extra: Partial<ConstructorParameters<typeof DriveApi>[0]> = {}) =>
  new DriveApi({ apiKey: d.apiKey, base: d.base, sleep: async () => {}, ...extra });

/** A clock that only moves when something sleeps, so backoff waits can be measured exactly. */
function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}
const source = (d: MockDrive, a: DriveApi = api(d), max = 1e9) => new GoogleDriveSource({ id: "src-drive", name: "BHEL tenders", folderId: ROOT, api: a, maxFileBytes: max });
const signal = () => new AbortController().signal;

async function scan(s: GoogleDriveSource) {
  const entries: SourceEntry[] = [];
  const skips: unknown[] = [];
  let others = 0;
  for await (const e of s.scan(signal(), (x) => skips.push(x), () => others++)) entries.push(e);
  return { entries, skips, others };
}

describe("parseDriveLink", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123";
  it("accepts every common folder link form and rebuilds the canonical link", () => {
    for (const link of [
      `https://drive.google.com/drive/folders/${id}`,
      `https://drive.google.com/drive/folders/${id}?usp=sharing`,
      `https://drive.google.com/drive/u/0/folders/${id}?usp=drive_link`,
      `https://drive.google.com/drive/mobile/folders/${id}`,
      `https://drive.google.com/open?id=${id}`,
      `https://drive.google.com/folderview?id=${id}&usp=sharing`,
      `  https://drive.google.com/drive/folders/${id}  `,
    ]) {
      expect(parseDriveLink(link), link).toEqual({ ok: true, folderId: id, link: canonicalFolderLink(id) });
    }
  });

  it("explains what's wrong with everything else", () => {
    const msg = (x: unknown) => {
      const r = parseDriveLink(x);
      return r.ok ? "OK" : r.message;
    };
    expect(msg("")).toMatch(/Paste/);
    expect(msg(42)).toMatch(/Paste/);
    expect(msg("not a url")).toMatch(/doesn't look like a Google Drive folder link/);
    expect(msg("https://example.com/drive/folders/" + id)).toMatch(/start with https:\/\/drive.google.com/);
    expect(msg("http://drive.google.com/drive/folders/" + id)).toMatch(/start with https/);
    expect(msg(`https://drive.google.com/file/d/${id}/view`)).toMatch(/single file/);
    expect(msg("https://drive.google.com/drive/my-drive")).toMatch(/doesn't look like/);
    expect(msg("https://drive.google.com/drive/folders/short")).toMatch(/doesn't look like/);
    expect(msg(`https://drive.google.com.evil.com/drive/folders/${id}`)).toMatch(/start with https/);
  });
});

describe("driveApiBase", () => {
  it("honours GOOGLE_DRIVE_API_BASE only for loopback addresses", () => {
    expect(driveApiBase({})).toBe(DEFAULT_DRIVE_BASE);
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "http://127.0.0.1:4000" })).toBe("http://127.0.0.1:4000");
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "http://localhost:4000/" })).toBe("http://localhost:4000");
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "http://10.0.0.5:4000" })).toBe(DEFAULT_DRIVE_BASE);
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "https://evil.example.com" })).toBe(DEFAULT_DRIVE_BASE);
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "http://169.254.169.254" })).toBe(DEFAULT_DRIVE_BASE);
    expect(driveApiBase({ GOOGLE_DRIVE_API_BASE: "not a url" })).toBe(DEFAULT_DRIVE_BASE);
  });
});

describe("GoogleDriveSource", () => {
  it("lists the folder recursively: PDFs only, the path inside the shared folder as the name, Drive ids as keys; everything else counted", async () => {
    drive = await startMockDrive(tree());
    const { entries, others, skips } = await scan(source(drive));
    expect(entries.map((e) => [e.key, e.displayName])).toEqual([
      ["f1", "a-notice.pdf"],
      ["f2", "b-spec.pdf"],
      ["f3", "2025/old.pdf"],
      ["f4", "2025/deeper/deep.pdf"],
    ]);
    expect(others).toBe(2); // the Google Doc and the JPEG
    expect(skips).toEqual([]);
    expect(entries[0]).toMatchObject({ sizeBytes: PDF("one").length, modifiedAt: "2026-02-01T10:00:00.000Z" });
  });

  it("follows page tokens: a folder of 25 files read 7 at a time is read completely", async () => {
    const files: MockFile[] = [{ id: ROOT, name: "big", mimeType: FOLDER_MIME, parent: null }];
    for (let i = 0; i < 25; i++) files.push({ id: `p${String(i).padStart(2, "0")}`, name: `doc-${String(i).padStart(2, "0")}.pdf`, parent: ROOT, content: PDF(String(i)) });
    drive = await startMockDrive(files, { pageSize: 7 });
    const { entries } = await scan(source(drive));
    expect(entries).toHaveLength(25);
    expect(drive.requests.filter((r) => r === "GET /files")).toHaveLength(4);
  });

  it("a folder reachable by two paths is walked once", async () => {
    const files = tree();
    files.push({ id: "f9", name: "shared.pdf", parent: "d1", content: PDF("nine") });
    // d2 also lists d1's other child folder as its own: simulate a cycle by making d1 a child of d2 as well.
    files.push({ id: "d1", name: "2025-again", mimeType: FOLDER_MIME, parent: "d2" });
    drive = await startMockDrive(files);
    const { entries } = await scan(source(drive));
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it("a file over the size limit is reported as a skip, not listed", async () => {
    drive = await startMockDrive(tree());
    const big = PDF("x".repeat(500));
    drive.files.push({ id: "big", name: "huge.pdf", parent: ROOT, content: big });
    const { entries, skips } = await scan(source(drive, api(drive), big.length - 1));
    expect(entries.map((e) => e.key)).not.toContain("big");
    expect(skips).toEqual([expect.objectContaining({ relPath: "huge.pdf", reason: "too-large" })]);
  });

  it("downloads to the temp folder, hashes by streaming, verifies Drive's md5, and cleanup deletes the file", async () => {
    drive = await startMockDrive(tree());
    const s = source(drive);
    const { entries } = await scan(s);
    const opened = await s.open(entries[0], tmp, signal());
    expect(path.dirname(opened.path)).toBe(tmp);
    expect(fs.readFileSync(opened.path).equals(PDF("one"))).toBe(true);
    const { createHash } = await import("node:crypto");
    expect(opened.sha256).toBe(createHash("sha256").update(PDF("one")).digest("hex"));
    expect(opened.sizeBytes).toBe(PDF("one").length);
    await opened.cleanup();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("a download that doesn't match Drive's checksum is refused and leaves nothing behind", async () => {
    drive = await startMockDrive(tree());
    drive.files.find((f) => f.id === "f1")!.md5Override = md5Of(Buffer.from("something else"));
    const s = source(drive);
    const { entries } = await scan(s);
    await expect(s.open(entries[0], tmp, signal())).rejects.toMatchObject({ kind: "unreadable", message: expect.stringContaining("checksum") });
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("a non-PDF named .pdf, and a file that grows past the limit while downloading, are refused cleanly", async () => {
    drive = await startMockDrive(tree());
    drive.files.push({ id: "fake", name: "fake.pdf", parent: ROOT, content: Buffer.from("not a pdf at all") });
    const s = source(drive);
    const { entries } = await scan(s);
    const fake = entries.find((e) => e.key === "fake")!;
    await expect(s.open(fake, tmp, signal())).rejects.toMatchObject({ kind: "not-a-pdf" });
    const small = source(drive, api(drive), 10);
    await expect(small.open({ ...entries[0], locator: JSON.stringify({ id: "f1", md5: null, size: null }) }, tmp, signal())).rejects.toBeInstanceOf(SourceFileError);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe("DriveApi: errors in plain language", () => {
  it("no key", async () => {
    drive = await startMockDrive(tree());
    await expect(new DriveApi({ apiKey: undefined, base: drive.base }).getFolder(ROOT)).rejects.toMatchObject({
      code: "no-key",
      message: "Google Drive isn't set up on this server (GOOGLE_API_KEY is missing).",
    });
    expect(drive.requests).toEqual([]); // nothing was sent
  });

  it("a key Google doesn't accept", async () => {
    drive = await startMockDrive(tree());
    await expect(new DriveApi({ apiKey: "wrong", base: drive.base }).getFolder(ROOT)).rejects.toMatchObject({ code: "bad-key", message: expect.stringContaining("GOOGLE_API_KEY") });
  });

  it("a private folder: 404 and 403 both say it isn't shared, and that private folders aren't supported yet", async () => {
    for (const status of [404, 403] as const) {
      drive = await startMockDrive(tree());
      drive.makePrivate(status);
      const err = (await api(drive).getFolder(ROOT).catch((e: unknown) => e)) as DriveError;
      expect(err).toMatchObject({ code: "not-shared" });
      expect(err.message).toContain("Private folders aren't supported yet");
      await drive.close();
    }
    drive = null;
  });

  it("a link to a file is 'not a folder'", async () => {
    drive = await startMockDrive(tree());
    await expect(api(drive).getFolder("f1")).rejects.toMatchObject({ message: "That link is to a file, not a folder." });
  });

  it("the Drive API not enabled for the key", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(1, 403, "accessNotConfigured");
    await expect(api(drive).getFolder(ROOT)).rejects.toMatchObject({ code: "api-disabled" });
  });
});

describe("DriveApi: rate limits", () => {
  it("429 with Retry-After: waits at least that long, then succeeds", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(2, 429, "rateLimitExceeded", 7);
    const clock = fakeClock();
    const a = api(drive, { ...clock, random: () => 0 });
    expect((await a.getFolder(ROOT)).name).toBe("BHEL tenders");
    expect(a.backoffs).toBe(2);
    expect(clock.sleeps).toEqual([7000, 7000]); // Retry-After beats the 1 s / 2 s exponential steps
  });

  it("403 rateLimitExceeded and userRateLimitExceeded back off exponentially with jitter (1 s, 2 s, 4 s...), up to 5 minutes", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(1, 403, "rateLimitExceeded");
    drive.failNext(1, 403, "userRateLimitExceeded");
    drive.failNext(1, 500, "backendError");
    const clock = fakeClock();
    const a = api(drive, { ...clock, random: () => 0.5 });
    await a.getFolder(ROOT);
    expect(clock.sleeps).toEqual([1500, 2500, 4500]);
  });

  it("gives up after 8 tries with a plain message", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(20, 429, "rateLimitExceeded");
    const a = api(drive, { sleep: async () => {}, maxTries: 4 });
    await expect(a.getFolder(ROOT)).rejects.toMatchObject({ code: "rate-limited", message: "Google is limiting requests right now; try again in a minute." });
    expect(drive.requests.length).toBe(4);
  });

  it("a daily limit is not retried: it says so and stops", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(1, 403, "dailyLimitExceeded");
    await expect(api(drive).getFolder(ROOT)).rejects.toMatchObject({ code: "daily-limit", message: expect.stringContaining("daily limit") });
    expect(drive.requests).toHaveLength(1);
  });

  it("one backoff slows every request: a second request waits out the first one's backoff", async () => {
    drive = await startMockDrive(tree());
    drive.failNext(1, 429, "rateLimitExceeded", 10);
    const clock = fakeClock();
    const a = api(drive, { ...clock, random: () => 0 });
    const [first, second] = await Promise.all([a.getFolder(ROOT), a.getFolder(ROOT)]);
    expect([first.id, second.id]).toEqual([ROOT, ROOT]);
    // One backoff closed the gate for 10 s. The request that hit it waited; the one that arrived while it was closed waited out the rest of it instead of piling on.
    expect(a.backoffs).toBe(1);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
    expect(Math.max(...clock.sleeps)).toBe(10_000);
  });

  it("retries a network failure, then reports it plainly", async () => {
    let calls = 0;
    const a = new DriveApi({
      apiKey: "k",
      base: "http://127.0.0.1:9",
      sleep: async () => {},
      maxTries: 3,
      fetchImpl: (async () => {
        calls++;
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(a.getFolder(ROOT)).rejects.toMatchObject({ code: "network", message: expect.stringContaining("Couldn't reach Google Drive") });
    expect(calls).toBe(3);
  });
});
