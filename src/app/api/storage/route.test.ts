import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-storage-route-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
  process.env.STORAGE_CAP_BYTES = "123456";
});

afterEach(() => {
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.STORAGE_CAP_BYTES;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/storage", () => {
  it("reports the configured cap and current usage, uncached", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { usedBytes: number; capBytes: number };
    expect(body.capBytes).toBe(123456);
    expect(body.usedBytes).toBeGreaterThanOrEqual(0);
  });

  it("usage grows when a file is written to the uploads directory", async () => {
    const before = (await (await GET()).json()) as { usedBytes: number };
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uploads", "x.pdf"), Buffer.alloc(10_000));
    const after = (await (await GET()).json()) as { usedBytes: number };
    expect(after.usedBytes).toBe(before.usedBytes + 10_000);
  });
});
