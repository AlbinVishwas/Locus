import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** storage.ts reads UPLOADS_DIR from the environment at call time, so each
 * test points it at its own temp directory. */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-storage-"));
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
});

afterEach(() => {
  delete process.env.UPLOADS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("storage", () => {
  it("writes and reads back a content-addressed file", async () => {
    const { storedPathFor, storedFileExists, writeStoredFile } = await import("./storage");
    expect(await storedFileExists("abc")).toBe(false);
    await writeStoredFile("abc", Buffer.from("hello"));
    expect(await storedFileExists("abc")).toBe(true);
    expect(fs.readFileSync(storedPathFor("abc"), "utf8")).toBe("hello");
  });

  it("deleteStoredFile removes the file and is idempotent", async () => {
    const { deleteStoredFile, storedFileExists, writeStoredFile } = await import("./storage");
    await writeStoredFile("xyz", Buffer.from("data"));
    await deleteStoredFile("xyz");
    expect(await storedFileExists("xyz")).toBe(false);
    // Second call: already gone, must not throw.
    await expect(deleteStoredFile("xyz")).resolves.toBeUndefined();
  });

  it("refuses to delete a path outside the uploads directory", async () => {
    const { deleteStoredFile } = await import("./storage");
    // A sha256 containing path separators would otherwise escape the
    // uploads directory via path.join -- confirm the guard catches it
    // rather than relying on sha256 always being a clean hex string.
    await expect(deleteStoredFile("../../etc/passwd")).rejects.toThrow(/outside the uploads directory/);
  });

  it("measureStorageUsage counts both the uploads dir and the index dir", async () => {
    const { measureStorageUsage, writeStoredFile } = await import("./storage");
    await writeStoredFile("one", Buffer.alloc(1000));
    const indexDir = path.join(dir, "index");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, "search.db"), Buffer.alloc(500));

    const usage = await measureStorageUsage(indexDir);
    expect(usage.uploadsBytes).toBe(1000);
    expect(usage.indexBytes).toBe(500);
    expect(usage.totalBytes).toBe(1500);
  });

  it("measureStorageUsage treats a missing directory as zero, not an error", async () => {
    const { measureStorageUsage } = await import("./storage");
    const usage = await measureStorageUsage(path.join(dir, "nonexistent"));
    expect(usage).toEqual({ uploadsBytes: 0, indexBytes: 0, totalBytes: 0 });
  });
});
