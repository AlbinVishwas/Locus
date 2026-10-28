import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { libraryPaths } from "../library/config";
import { fakeGuard, makePdf } from "../library/testing/helpers";
import { FolderConnector } from "./folderConnector";
import { loadServerConfig } from "./config";
import { S3Connector } from "./s3Connector";
import { documents, failures, find, openLibrary, syncOnce } from "./testing/serverHarness";
import { MockS3 } from "./testing/mockS3";
import type { StorageConnector } from "./types";

/**
 * The storage server end to end through the real indexer: first index, then add / change / delete on the server
 * and a sync that picks exactly that up; the same against an S3-compatible server; a crash and resume; the server
 * going away.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
let root: string;
let server: string;
let data: string;
let work: string;
// A library run points TMPDIR at its own folder (see prepareProcessForLibraryRun); put it back after each test.
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };

beforeEach(() => {
  for (const [k, v] of Object.entries(savedTmp)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-sync-"));
  server = path.join(root, "server");
  data = path.join(root, "data");
  work = path.join(root, "work");
  for (const d of [server, data, work]) fs.mkdirSync(d);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedTmp)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  fs.rmSync(root, { recursive: true, force: true });
});

const text = (marker: string) => [{ lines: [`Reference ${marker} appears on this typed page, with enough text to count as a text layer.`] }];
async function pdf(rel: string, marker: string, extraPages = 0): Promise<void> {
  await makePdf(path.join(server, rel), [...text(marker), ...Array.from({ length: extraPages }, (_, i) => ({ lines: [`Filler page ${i}, plain text that is long enough to count as a real text layer.`] }))], work);
}

/** A connector that counts how many files were actually opened, to show unchanged files aren't read again. */
class Counting extends FolderConnector {
  reads: string[] = [];
  override async read(...a: Parameters<FolderConnector["read"]>) {
    this.reads.push(a[0]);
    return super.read(...a);
  }
}

describe("folder server: first index, then add / change / delete", () => {
  it("indexes everything, then a sync picks up exactly what changed", async () => {
    await pdf("a.pdf", "alphamarker");
    await pdf("sub/b.pdf", "bravomarker");
    await pdf("sub/deep/c.pdf", "charliemarker");
    fs.writeFileSync(path.join(server, "readme.txt"), "not a pdf");

    const first = new Counting(server);
    const run1 = await syncOnce(first, data);
    expect(run1.progress.filesIndexed).toBe(3);
    expect(documents(data).map((d) => [d.key, d.status])).toEqual([
      ["a.pdf", "ready"],
      ["sub/b.pdf", "ready"],
      ["sub/deep/c.pdf", "ready"],
    ]);
    expect(find(data, "bravomarker")).toEqual([{ key: "sub/b.pdf", page: 1 }]);
    expect(run1.progress.scanOthers).toBe(1); // the .txt was noticed and ignored

    // On the server: one file added, one changed, one deleted, one untouched.
    await pdf("new/d.pdf", "deltamarker");
    await pdf("sub/b.pdf", "bravorewritten", 1); // changed (a different size)
    fs.rmSync(path.join(server, "sub/deep/c.pdf"));

    const second = new Counting(server);
    const run2 = await syncOnce(second, data);
    expect(run2.progress.filesIndexed).toBe(2); // d (new) + b (changed)
    expect(run2.progress.filesDeleted).toBe(1);
    expect(second.reads.sort()).toEqual(["new/d.pdf", "sub/b.pdf"]); // a.pdf was NOT read again
    expect(documents(data).map((d) => d.key)).toEqual(["a.pdf", "new/d.pdf", "sub/b.pdf"]);
    expect(find(data, "deltamarker")).toEqual([{ key: "new/d.pdf", page: 1 }]);
    expect(find(data, "bravorewritten")).toEqual([{ key: "sub/b.pdf", page: 1 }]);
    expect(find(data, "bravomarker")).toEqual([]); // the old text of the changed file is gone
    expect(find(data, "charliemarker")).toEqual([]); // the deleted file is out of the index
    expect(find(data, "alphamarker")).toEqual([{ key: "a.pdf", page: 1 }]);
  }, 120_000);

  it("never writes to the server: every file on it is byte-identical, with the same times, afterwards", async () => {
    await pdf("a.pdf", "alphamarker");
    await pdf("sub/b.pdf", "bravomarker");
    const { snapshotTree } = await import("../library/testing/helpers");
    const before = snapshotTree(server);
    await syncOnce(new FolderConnector(server), data);
    await syncOnce(new FolderConnector(server), data);
    expect(snapshotTree(server)).toEqual(before);
  }, 120_000);

  it("temp copies of the PDFs are deleted: the library's tmp folder is empty after a sync", async () => {
    await pdf("a.pdf", "alphamarker");
    await syncOnce(new FolderConnector(server), data);
    expect(fs.readdirSync(libraryPaths(data).tmp)).toEqual([]);
  }, 60_000);

  it("a renamed file is recognised by its content, not re-read as new text", async () => {
    await pdf("old-name.pdf", "echomarker");
    await syncOnce(new FolderConnector(server), data);
    fs.renameSync(path.join(server, "old-name.pdf"), path.join(server, "new-name.pdf"));
    const run = await syncOnce(new FolderConnector(server), data);
    expect(run.progress.filesRenamed).toBe(1);
    expect(find(data, "echomarker")).toEqual([{ key: "new-name.pdf", page: 1 }]);
    expect(documents(data).map((d) => d.key)).toEqual(["new-name.pdf"]);
  }, 60_000);

  it("when the server goes away, what is already indexed stays searchable, nothing is swept, and the problem is recorded with its code", async () => {
    await pdf("a.pdf", "alphamarker");
    await pdf("b.pdf", "bravomarker");
    await syncOnce(new FolderConnector(server), data);
    expect(documents(data).length).toBe(2);

    fs.renameSync(server, `${server}-offline`); // the share is unmounted
    const run = await syncOnce(new FolderConnector(server, { opTimeoutMs: 200, retries: 1, retryDelayMs: 5 }), data);
    expect(run.progress.filesDeleted).toBe(0);
    expect(documents(data).map((d) => d.status)).toEqual(["ready", "ready"]);
    expect(find(data, "bravomarker")).toEqual([{ key: "b.pdf", page: 1 }]); // search still answers
    const db = openLibrary(data);
    const err = db.prepare("SELECT last_error FROM sources WHERE id = 'env-server'").pluck().get() as string;
    db.close();
    expect(err).toMatch(/^LOCUS-SERVER-001:/);

    // The server comes back: the next sync clears the problem and carries on.
    fs.renameSync(`${server}-offline`, server);
    await pdf("c.pdf", "charliemarker");
    await syncOnce(new FolderConnector(server), data);
    expect(find(data, "charliemarker")).toEqual([{ key: "c.pdf", page: 1 }]);
    const db2 = openLibrary(data);
    expect(db2.prepare("SELECT last_error FROM sources WHERE id = 'env-server'").pluck().get()).toBeNull();
    db2.close();
  }, 120_000);
});

describe("S3 server: first index, then add / change / delete", () => {
  let s3: MockS3;
  let c: () => StorageConnector;
  beforeEach(async () => {
    s3 = new MockS3();
    const endpoint = await s3.start();
    const cfg = loadServerConfig({ LOCUS_SERVER_TYPE: "s3", LOCUS_SERVER_S3_ENDPOINT: endpoint, LOCUS_SERVER_S3_BUCKET: "tenders", LOCUS_SERVER_S3_ACCESS_KEY: s3.accessKey, LOCUS_SERVER_S3_SECRET_KEY: "secret-secret-secret" });
    if (cfg.type !== "s3") throw new Error("s3");
    c = () => new S3Connector(cfg, { maxAttempts: 2, requestTimeoutMs: 3000 });
  });
  afterEach(async () => s3.stop());

  async function put(key: string, marker: string, extra = 0, mtime = new Date(Date.now() - 3_600_000)): Promise<void> {
    const file = path.join(work, "tmp.pdf");
    await makePdf(file, [...text(marker), ...Array.from({ length: extra }, (_, i) => ({ lines: [`Filler page ${i}, plain text that is long enough to count as a real text layer.`] }))], work);
    s3.put(key, fs.readFileSync(file), mtime);
  }

  it("indexes the bucket, then picks up an added, a replaced and a deleted object, and writes nothing to the server", async () => {
    await put("tenders/a.pdf", "alphamarker");
    await put("tenders/sub/b.pdf", "bravomarker");
    await put("tenders/c.pdf", "charliemarker");
    s3.put("tenders/notes.txt", "x");
    const run1 = await syncOnce(c(), data);
    expect(run1.progress.filesIndexed).toBe(3);
    expect(find(data, "bravomarker")).toEqual([{ key: "tenders/sub/b.pdf", page: 1 }]);

    await put("tenders/d.pdf", "deltamarker");
    // Replaced with different content but the SAME size and timestamp: only the etag differs.
    const old = s3.objects.get("tenders/a.pdf")!;
    await put("tenders/a.pdf", "alphamarker".replace("alpha", "omega"), 0, old.mtime);
    const same = s3.objects.get("tenders/a.pdf")!;
    expect(same.body.length).toBe(old.body.length);
    expect(same.etag).not.toBe(old.etag);
    s3.delete("tenders/c.pdf");

    const run2 = await syncOnce(c(), data);
    expect(run2.progress.filesIndexed).toBe(2); // d (new) + a (replaced, caught by its etag)
    expect(run2.progress.filesDeleted).toBe(1);
    expect(find(data, "omegamarker")).toEqual([{ key: "tenders/a.pdf", page: 1 }]);
    expect(find(data, "alphamarker")).toEqual([]);
    expect(find(data, "charliemarker")).toEqual([]);
    expect(find(data, "deltamarker")).toEqual([{ key: "tenders/d.pdf", page: 1 }]);
    expect(s3.writes()).toBe(0);
  }, 120_000);

  it("a server that refuses the login leaves the index untouched and says why", async () => {
    await put("a.pdf", "alphamarker");
    await syncOnce(c(), data);
    s3.failWith = 403;
    await syncOnce(c(), data);
    expect(documents(data).map((d) => d.status)).toEqual(["ready"]);
    const db = openLibrary(data);
    const err = db.prepare("SELECT last_error FROM sources WHERE id = 'env-server'").pluck().get() as string;
    db.close();
    expect(err).toMatch(/^LOCUS-SERVER-00[12]:/);
    expect(err).not.toMatch(/secret-secret|AKIATEST/);
  }, 60_000);
});

describe("per-file failures never stop the job", () => {
  it("corrupt, not-a-PDF, password-protected and vanished files are skipped and listed with a reason; the rest are indexed", async () => {
    await pdf("good1.pdf", "alphamarker");
    await pdf("good2.pdf", "bravomarker");
    fs.writeFileSync(path.join(server, "corrupt.pdf"), "%PDF-1.4\nthis is not really a pdf\n");
    fs.writeFileSync(path.join(server, "not-a-pdf.pdf"), "just some text saved with a .pdf name");
    const { encryptedPdf, PERMISSIONS } = await import("../library/testing/encryptedPdf");
    fs.writeFileSync(path.join(server, "locked.pdf"), encryptedPdf({ text: "secret contents", userPassword: "secret", ownerPassword: "owner", permissions: PERMISSIONS.all }));
    fs.writeFileSync(path.join(server, "empty.pdf"), "");

    const run = await syncOnce(new FolderConnector(server), data);
    expect(documents(data).map((d) => d.key)).toEqual(["good1.pdf", "good2.pdf"]);
    expect(run.progress.filesIndexed).toBe(2);
    const byKey = Object.fromEntries(failures(data).map((f) => [f.key, f]));
    expect(byKey["corrupt.pdf"]).toMatchObject({ kind: "corrupt" });
    expect(byKey["not-a-pdf.pdf"]).toMatchObject({ kind: "not-a-pdf" });
    expect(byKey["locked.pdf"]).toMatchObject({ kind: "encrypted" });
    expect(byKey["locked.pdf"].message).toMatch(/password/i);
    expect(Object.keys(byKey)).toContain("empty.pdf");
    expect(find(data, "bravomarker")).toEqual([{ key: "good2.pdf", page: 1 }]);

    // A second sync doesn't retry the unchanged broken files over and over.
    class Spy extends FolderConnector {
      reads: string[] = [];
      override async read(...a: Parameters<FolderConnector["read"]>) {
        this.reads.push(a[0]);
        return super.read(...a);
      }
    }
    const spy = new Spy(server);
    await syncOnce(spy, data);
    expect(spy.reads).toEqual([]);
  }, 120_000);

  it("a file that vanishes between the listing and the read is recorded as 'vanished' and doesn't stop the others", async () => {
    await pdf("a.pdf", "alphamarker");
    await pdf("b.pdf", "bravomarker");
    class Vanishing extends FolderConnector {
      override async read(rel: string, ...rest: [AbortSignal?, { start: number; end: number }?]) {
        if (rel === "a.pdf") fs.rmSync(path.join(server, "a.pdf"), { force: true });
        return super.read(rel, ...rest);
      }
    }
    await syncOnce(new Vanishing(server), data);
    expect(documents(data).map((d) => d.key)).toEqual(["b.pdf"]);
    expect(failures(data)).toEqual([expect.objectContaining({ key: "a.pdf", kind: "vanished" })]);
  }, 60_000);
});

describe("crash and resume with the storage server", () => {
  function harness(dataDir: string): ChildProcess {
    return spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "testing/serverHarness.ts"), server, dataDir, JSON.stringify({ filesInFlight: 2, pageWindow: 1 })], {
      cwd: ROOT,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const finish = (child: ChildProcess) => {
    let out = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (out += c));
    return new Promise<{ code: number | null; out: string }>((resolve) => child.on("exit", (code) => resolve({ code, out })));
  };
  const ready = (dir: string) => {
    try {
      const db = new Database(libraryPaths(dir).db, { readonly: true });
      try {
        return Number(db.prepare("SELECT count(*) FROM documents WHERE status = 'ready'").pluck().get());
      } finally {
        db.close();
      }
    } catch {
      return 0;
    }
  };
  const snapshot = (dir: string) => {
    const db = new Database(libraryPaths(dir).db, { readonly: true });
    try {
      return {
        documents: db.prepare("SELECT key, status, page_count, pages_done, sha256 FROM documents ORDER BY key").all(),
        pages: db.prepare("SELECT d.key, p.page_no, p.source FROM pages p JOIN documents d ON d.id = p.doc_id ORDER BY d.key, p.page_no").all(),
        texts: db.prepare("SELECT count(*) FROM texts").pluck().get(),
        exactRows: db.prepare("SELECT count(*) FROM texts_exact_docsize").pluck().get(),
        jobs: db.prepare("SELECT count(*) FROM jobs").pluck().get(),
        integrity: db.prepare("PRAGMA integrity_check").pluck().get(),
      };
    } finally {
      db.close();
    }
  };

  it("SIGKILL mid-index, restart: the index ends up identical to an uninterrupted run, nothing re-read that was done, no half-written file", async () => {
    for (let i = 0; i < 10; i++) await pdf(`f${String(i).padStart(2, "0")}.pdf`, `marker${"abcdefghij"[i]}x`, 4);

    const clean = path.join(root, "clean");
    fs.mkdirSync(clean);
    const ok = await finish(harness(clean));
    expect(ok.code, ok.out).toBe(0);

    const crashed = path.join(root, "crashed");
    fs.mkdirSync(crashed);
    const child = harness(crashed);
    const exited = finish(child);
    const deadline = Date.now() + 150_000;
    while (ready(crashed) < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    child.kill("SIGKILL");
    expect((await exited).code).toBeNull();
    const midway = ready(crashed);
    expect(midway).toBeGreaterThanOrEqual(3);
    expect(midway).toBeLessThan(10);

    const resumed = await finish(harness(crashed));
    expect(resumed.code, resumed.out).toBe(0);
    expect(resumed.out).toMatch(/Resuming|DONE/);
    // What was finished before the kill wasn't indexed again.
    const done = JSON.parse(resumed.out.split("DONE ")[1].split("\n")[0]) as { indexed: number; unchanged: number };
    expect(done.indexed).toBeLessThanOrEqual(10 - midway + 2);

    const a = snapshot(clean);
    const b = snapshot(crashed);
    expect(b.integrity).toBe("ok");
    expect(b.documents).toEqual(a.documents);
    expect(b.pages).toEqual(a.pages);
    expect(b.texts).toBe(a.texts);
    expect(b.exactRows).toBe(a.exactRows);
    expect(b.jobs).toBe(0);
    expect(fs.readdirSync(libraryPaths(crashed).tmp)).toEqual([]);
  }, 300_000);
});

describe("disk space", () => {
  it("won't start when the index can't fit: nothing is indexed, nothing is half-written, and the message says how much it needs and how much is free", async () => {
    await pdf("a.pdf", "alphamarker");
    await pdf("b.pdf", "bravomarker");
    const { planSpace, spaceMessage, measureServer } = await import("./preflight");
    const counted = await measureServer(new FolderConnector(server), new AbortController().signal, 1e9);
    expect(counted.files).toBe(2);
    const plan = planSpace({ ...counted, freeBytes: 5 * 1024 ** 2 + 100, reserveBytes: 5 * 1024 ** 2 });
    expect(plan.fits).toBe(false);

    const run = await syncOnce(new FolderConnector(server), data, {
      beforeScan: async (signal) => {
        const m = await measureServer(new FolderConnector(server), signal, 1e9);
        const p = planSpace({ ...m, freeBytes: 5 * 1024 ** 2 + 100, reserveBytes: 5 * 1024 ** 2 });
        if (!p.fits) throw new Error(spaceMessage(p, data));
      },
    });
    expect(run.progress.filesIndexed).toBe(0);
    expect(documents(data)).toEqual([]);
    const db = openLibrary(data);
    const err = db.prepare("SELECT last_error FROM sources WHERE id = 'env-server'").pluck().get() as string;
    db.close();
    expect(err).toMatch(/^LOCUS-DISK-001: Not enough disk space/);
    expect(err).toMatch(/needs about \d+ KB, but only 1 KB is free after keeping 5 MB in reserve/); // 100 bytes usable, shown as the smallest unit
    expect(err).toMatch(/LOCUS_DATA_DIR/);
  }, 60_000);

  it("pauses cleanly when space runs low mid-index, keeps what's indexed searchable, and resumes by itself when there is room", async () => {
    for (let i = 0; i < 6; i++) await pdf(`f${i}.pdf`, `marker${"abcdef"[i]}x`, 8);
    const guard = fakeGuard(data, 1024);
    let indexer: import("../library/pipeline").LibraryIndexer | undefined;
    const done = syncOnce(new FolderConnector(server), data, { guard, onIndexer: (i) => (indexer = i), config: { filesInFlight: 1, pageWindow: 2 } });
    const until = async (cond: () => boolean, ms = 60_000) => {
      const end = Date.now() + ms;
      while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(cond()).toBe(true);
    };

    await until(() => documents(data).some((d) => d.status === "ready"));
    guard.free = 10; // the disk fills up: below the reserve
    await until(() => indexer?.progress.state === "paused: low disk space");
    // Paused: everything already indexed is still searchable, and the database is sound.
    const readyKeys = documents(data).filter((d) => d.status === "ready").map((d) => d.key);
    expect(readyKeys.length).toBeGreaterThan(0);
    const n = Number(readyKeys[0].match(/f(\d)/)![1]);
    expect(find(data, `marker${"abcdef"[n]}x`).map((h) => h.key)).toEqual([readyKeys[0]]);
    const db = openLibrary(data);
    expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
    db.close();
    const before = documents(data).filter((d) => d.status === "ready").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(documents(data).filter((d) => d.status === "ready").length).toBeLessThanOrEqual(before + 1); // no progress while paused (at most the file in hand)

    guard.free = 100 * 1024 ** 3; // someone frees space
    const run = await done;
    expect(run.progress.filesIndexed).toBe(6); // it resumed by itself and finished
    expect(documents(data).every((d) => d.status === "ready")).toBe(true);
  }, 120_000);
});
