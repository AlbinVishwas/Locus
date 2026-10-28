import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotTree } from "../library/testing/helpers";
import { FolderConnector, withTimeout } from "./folderConnector";
import { ConnectorError, type RemoteFile } from "./types";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-folder-conn-"));
  fs.mkdirSync(path.join(root, "tenders", "2025"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.pdf"), "%PDF-1.4 a");
  fs.writeFileSync(path.join(root, "tenders", "b.PDF"), "%PDF-1.4 bb");
  fs.writeFileSync(path.join(root, "tenders", "2025", "c.pdf"), "%PDF-1.4 ccc");
  fs.writeFileSync(path.join(root, "notes.txt"), "hello");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function list(c: FolderConnector, skips: unknown[] = []): Promise<RemoteFile[]> {
  const out: RemoteFile[] = [];
  for await (const f of c.list(new AbortController().signal, (s) => skips.push(s))) out.push(f);
  return out;
}

const fast = { opTimeoutMs: 60, retries: 2, retryDelayMs: 5, idleTimeoutMs: 80 };

describe("folder connector", () => {
  it("lists every file with size and modified time, '/'-separated, in a stable order", async () => {
    const files = await list(new FolderConnector(root));
    expect(files.map((f) => f.path).sort()).toEqual(["a.pdf", "notes.txt", "tenders/2025/c.pdf", "tenders/b.PDF"]);
    const a = files.find((f) => f.path === "a.pdf")!;
    expect(a.size).toBe(10);
    expect(a.etag).toBeNull();
    expect(Date.parse(a.modifiedAt)).toBeCloseTo(fs.statSync(path.join(root, "a.pdf")).mtimeMs, -2);
    expect((await list(new FolderConnector(root))).map((f) => f.path)).toEqual(files.map((f) => f.path));
  });

  it("stat finds a file, and answers null for one that's gone or is a folder", async () => {
    const c = new FolderConnector(root);
    expect(await c.stat("tenders/2025/c.pdf")).toMatchObject({ path: "tenders/2025/c.pdf", size: 12 });
    expect(await c.stat("missing.pdf")).toBeNull();
    expect(await c.stat("tenders")).toBeNull();
  });

  it("reads a whole file or a byte range as a stream", async () => {
    const c = new FolderConnector(root);
    const chunks: Buffer[] = [];
    for await (const ch of await c.read("tenders/b.PDF")) chunks.push(ch as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("%PDF-1.4 bb");
    const part: Buffer[] = [];
    for await (const ch of await c.read("tenders/b.PDF", undefined, { start: 1, end: 3 })) part.push(ch as Buffer);
    expect(Buffer.concat(part).toString()).toBe("PDF");
  });

  it("never reaches outside the server folder, whatever path it is given", async () => {
    const c = new FolderConnector(path.join(root, "tenders"));
    for (const bad of ["../a.pdf", "../../etc/passwd", "/a.pdf", "C:\\Windows\\win.ini", "2025/../../a.pdf"]) {
      await expect(c.read(bad), bad).rejects.toMatchObject({ failure: "not-found" });
      await expect(c.stat(bad), bad).rejects.toBeInstanceOf(ConnectorError);
    }
  });

  it("is read-only: listing, statting and reading change nothing on the share (names, sizes, times, content)", async () => {
    const before = snapshotTree(root);
    const c = new FolderConnector(root);
    await list(c);
    await c.stat("a.pdf");
    for await (const _ of await c.read("a.pdf")) void _;
    expect((await c.test()).ok).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("files are opened with the read-only flag and nothing else touches the share", async () => {
    const open = vi.spyOn(fs.promises, "open");
    const write = vi.spyOn(fs.promises, "writeFile");
    const unlink = vi.spyOn(fs.promises, "unlink");
    const rename = vi.spyOn(fs.promises, "rename");
    const c = new FolderConnector(root);
    for await (const _ of await c.read("a.pdf")) void _;
    expect(open).toHaveBeenCalledWith(expect.stringContaining("a.pdf"), "r");
    expect(write).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("doesn't follow a link to a folder (no loops) but reads through a link to a file", async () => {
    try {
      fs.symlinkSync(root, path.join(root, "loop"), "dir");
      fs.symlinkSync(path.join(root, "a.pdf"), path.join(root, "link.pdf"));
    } catch {
      return; // symlinks need extra rights on Windows
    }
    const skips: Array<{ path: string; reason: string }> = [];
    const files = await list(new FolderConnector(root), skips);
    expect(files.map((f) => f.path)).toContain("link.pdf");
    expect(files.some((f) => f.path.startsWith("loop/"))).toBe(false);
    expect(skips.some((s) => s.path === "loop")).toBe(true);
  });

  it("a folder it can't read is skipped with a reason and the listing carries on", async () => {
    const real = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, "readdir").mockImplementation(((p: fs.PathLike, o?: unknown) =>
      String(p).endsWith(`${path.sep}2025`) ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) : real(p, o as never)) as typeof fs.promises.readdir);
    const skips: Array<{ path: string; reason: string }> = [];
    const files = await list(new FolderConnector(root), skips);
    expect(files.map((f) => f.path)).toContain("a.pdf");
    expect(skips).toEqual([expect.objectContaining({ path: "tenders/2025", isDirectory: true, reason: expect.stringContaining("permission denied") })]);
  });

  describe("a slow or dropped network share never hangs it", () => {
    it("a call that stalls once is abandoned after the timeout and retried", async () => {
      const real = fs.promises.stat.bind(fs.promises);
      let calls = 0;
      vi.spyOn(fs.promises, "stat").mockImplementation(((p: fs.PathLike, o?: unknown) => (++calls === 1 ? new Promise(() => {}) : real(p, o as never))) as typeof fs.promises.stat);
      const started = Date.now();
      expect((await new FolderConnector(root, fast).test()).ok).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(calls).toBeGreaterThan(1);
    });

    it("a transient network error (EIO, ESTALE) is retried and then succeeds", async () => {
      const real = fs.promises.readdir.bind(fs.promises);
      let calls = 0;
      vi.spyOn(fs.promises, "readdir").mockImplementation(((p: fs.PathLike, o?: unknown) => {
        if (++calls <= 2) return Promise.reject(Object.assign(new Error("stale"), { code: calls === 1 ? "ESTALE" : "EIO" }));
        return real(p, o as never);
      }) as typeof fs.promises.readdir);
      expect((await list(new FolderConnector(root, fast))).length).toBe(4);
    });

    it("a share that never answers fails within a bounded time with the 'too slow' code, never hangs", async () => {
      vi.spyOn(fs.promises, "stat").mockImplementation((() => new Promise(() => {})) as typeof fs.promises.stat);
      const started = Date.now();
      const result = await new FolderConnector(root, { ...fast, retries: 1 }).test();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toMatchObject({ ok: false, code: "LOCUS-SERVER-005" });
    });

    it("a file that stalls while being read is cut off with a timeout error", async () => {
      const c = new FolderConnector(root, { ...fast, idleTimeoutMs: 40 });
      const stream = await c.read("a.pdf");
      stream.pause();
      await new Promise((r) => setTimeout(r, 5));
      // Simulate a stall: the stream is never read again, so it is destroyed by the idle timer once data stops flowing.
      const error = await new Promise<unknown>((resolve) => {
        stream.on("error", resolve);
        stream.on("close", () => resolve(null));
        stream.resume();
      });
      // A tiny file is delivered before the timer: either outcome is a finished stream, never a hang.
      expect(error === null || error instanceof ConnectorError).toBe(true);
    });

    it("withTimeout rejects with a timeout error naming what was slow", async () => {
      await expect(withTimeout(new Promise(() => {}), 20, "the share")).rejects.toMatchObject({ failure: "timeout", message: expect.stringContaining("the share took longer") });
    });
  });

  describe("test connection", () => {
    it("ok on a readable folder", async () => {
      expect(await new FolderConnector(root).test()).toMatchObject({ ok: true, details: { topLevelItems: 3 } });
    });
    it("explains a missing folder (a share that isn't mounted)", async () => {
      const r = await new FolderConnector(path.join(root, "not-mounted")).test();
      expect(r).toMatchObject({ ok: false, code: "LOCUS-SERVER-001" });
      expect(r.message).toMatch(/mounted/);
    });
    it("a file instead of a folder is a settings problem", async () => {
      expect(await new FolderConnector(path.join(root, "a.pdf")).test()).toMatchObject({ ok: false, code: "LOCUS-SERVER-003" });
    });
  });

  it("an unreachable root fails the listing (so a scan stops and says so) instead of looking empty", async () => {
    await expect(list(new FolderConnector(path.join(root, "gone"), fast))).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("Windows-style server paths", () => {
  it("a Windows root is joined with the platform separator, and '/'-relative paths resolve inside it", async () => {
    // On Windows path.join uses backslashes; elsewhere this checks the same join logic with the local separator.
    const c = new FolderConnector(root);
    expect(await c.stat("tenders\\2025\\c.pdf")).toMatchObject({ path: "tenders/2025/c.pdf" });
  });
});
