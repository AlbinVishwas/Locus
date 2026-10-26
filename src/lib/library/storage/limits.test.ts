import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { libraryPaths } from "../config";
import { defaultMarginBytes, evaluateLimits, limitStateLabel } from "./limits";
import { directoryDiskBytes, UsageMeter } from "./usage";

const GB = 1024 ** 3;
const base = { capBytes: 100 * GB, minFreeBytes: 20 * GB, marginBytes: 0 };

describe("evaluateLimits", () => {
  it("ok well under both limits, carrying the numbers", () => {
    expect(evaluateLimits({ ...base, usedBytes: 10 * GB, freeBytes: 96 * GB })).toEqual({
      ok: true,
      usedBytes: 10 * GB,
      capBytes: 100 * GB,
      freeBytes: 96 * GB,
      minFreeBytes: 20 * GB,
    });
  });

  it("pauses at the cap, with this exact message", () => {
    const s = evaluateLimits({ ...base, usedBytes: 99.8 * GB + 0.2 * GB, freeBytes: 200 * GB });
    expect(s).toMatchObject({ ok: false, kind: "cap" });
    if (!s.ok) {
      expect(s.message).toBe(
        "Paused: storage limit. The library uses 100.0 GB of its 100.0 GB limit. Remove a source, or raise LOCUS_LIBRARY_MAX_GB. Nothing has been deleted."
      );
    }
    const near = evaluateLimits({ ...base, usedBytes: 99.92 * GB, freeBytes: 200 * GB, marginBytes: 0.1 * GB });
    expect(near.ok).toBe(false);
    if (!near.ok) expect(near.message).toContain("The library uses 99.9 GB of its 100.0 GB limit.");
  });

  it("pauses at the reserve even far under the cap (this laptop: 96 GB free, 20 GB kept)", () => {
    const s = evaluateLimits({ ...base, usedBytes: 5 * GB, freeBytes: 18.2 * GB });
    expect(s).toMatchObject({ ok: false, kind: "reserve" });
    if (!s.ok) {
      expect(s.message).toBe(
        "Paused: low disk space. 18.2 GB free; Locus keeps 20.0 GB in reserve. Free some space on this Mac; indexing resumes on its own."
      );
    }
  });

  it("the margin keeps a write just before the check from overshooting the cap", () => {
    const margin = 256 * 1024 * 1024;
    expect(evaluateLimits({ ...base, usedBytes: 100 * GB - margin - 1, freeBytes: 200 * GB, marginBytes: margin }).ok).toBe(true);
    expect(evaluateLimits({ ...base, usedBytes: 100 * GB - margin, freeBytes: 200 * GB, marginBytes: margin }).ok).toBe(false);
  });

  it("resumes when usage drops or free space returns (it is a pure function of the numbers)", () => {
    expect(evaluateLimits({ ...base, usedBytes: 100 * GB, freeBytes: 50 * GB }).ok).toBe(false);
    expect(evaluateLimits({ ...base, usedBytes: 60 * GB, freeBytes: 50 * GB }).ok).toBe(true);
    expect(evaluateLimits({ ...base, usedBytes: 60 * GB, freeBytes: 10 * GB }).ok).toBe(false);
    expect(evaluateLimits({ ...base, usedBytes: 60 * GB, freeBytes: 30 * GB }).ok).toBe(true);
  });

  it("default margin: 256 MB, but never more than 2% of a small cap", () => {
    expect(defaultMarginBytes(100 * GB)).toBe(256 * 1024 * 1024);
    expect(defaultMarginBytes(1000)).toBe(20);
  });

  it("status words for the Sources page", () => {
    expect(limitStateLabel("cap")).toBe("paused: storage limit");
    expect(limitStateLabel("reserve")).toBe("paused: low disk space");
  });
});

describe("real disk usage", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-usage-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts allocated blocks, not file size: a sparse file barely counts, a written one counts in full", () => {
    const sparse = path.join(dir, "sparse");
    const fd = fs.openSync(sparse, "w");
    fs.ftruncateSync(fd, 500 * 1024 * 1024); // 500 MB apparent, nothing written
    fs.closeSync(fd);
    expect(fs.statSync(sparse).size).toBe(500 * 1024 * 1024);
    expect(directoryDiskBytes(dir)).toBeLessThan(1024 * 1024);

    fs.writeFileSync(path.join(dir, "real"), Buffer.alloc(3 * 1024 * 1024, 1));
    const used = directoryDiskBytes(dir);
    expect(used).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(used).toBeLessThan(3 * 1024 * 1024 + 1024 * 1024);
  });

  it("walks sub-folders, and a missing folder is zero", () => {
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "b", "f"), Buffer.alloc(1024 * 1024, 2));
    expect(directoryDiskBytes(dir)).toBeGreaterThanOrEqual(1024 * 1024);
    expect(directoryDiskBytes(path.join(dir, "nope"))).toBe(0);
  });

  it("the meter sees growth in the index between full walks (the fast path)", () => {
    const paths = libraryPaths(dir);
    for (const d of [paths.root, paths.tmp, paths.logs]) fs.mkdirSync(d, { recursive: true });
    let now = 1_000_000;
    const meter = new UsageMeter(paths, 30_000, () => now);
    fs.writeFileSync(paths.db, Buffer.alloc(1024 * 1024, 1));
    const first = meter.usedBytes(); // walks
    expect(first).toBeGreaterThanOrEqual(1024 * 1024);

    fs.appendFileSync(paths.db, Buffer.alloc(4 * 1024 * 1024, 2)); // the index grows...
    now += 1000; // ...well within the walk interval
    expect(meter.usedBytes()).toBeGreaterThanOrEqual(first + 4 * 1024 * 1024);

    // Things outside the fast-path files are picked up at the next walk.
    fs.writeFileSync(path.join(paths.logs, "big.log"), Buffer.alloc(2 * 1024 * 1024, 3));
    now += 31_000;
    expect(meter.usedBytes()).toBeGreaterThanOrEqual(first + 6 * 1024 * 1024);
  });

  it("counts everything the library writes: index, OCR cache, registry, logs, temp files", () => {
    const paths = libraryPaths(dir);
    for (const d of [paths.tmp, paths.logs, paths.inventory]) fs.mkdirSync(d, { recursive: true });
    for (const f of [paths.db, paths.ocrCache, paths.sources, path.join(paths.logs, "run.log"), path.join(paths.tmp, "page.png"), path.join(paths.inventory, "report.md")]) {
      fs.writeFileSync(f, Buffer.alloc(512 * 1024, 7));
    }
    expect(new UsageMeter(paths).usedBytes()).toBeGreaterThanOrEqual(6 * 512 * 1024);
  });
});
