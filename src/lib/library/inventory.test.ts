import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "./config";
import {
  analyzeSample,
  histAdd,
  histQuantile,
  pagesToExamine,
  project,
  renderReport,
  reservoirAdd,
  reservoirMerge,
  scanInventory,
  type Histogram,
  type Reservoir,
  type ScanSettings,
} from "./inventory";
import { mulberry32 } from "./pipeline";
import { makePdf } from "./testing/helpers";

const skipOcr = process.env.SKIP_OCR_TESTS === "1";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-inventory-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("constant-memory statistics", () => {
  it("size percentiles from log buckets are within ~1% of the exact values", () => {
    const rng = mulberry32(1);
    const sizes = Array.from({ length: 20_000 }, () => Math.floor(Math.exp(rng() * 18) + 100));
    const h: Histogram = { buckets: {}, count: 0 };
    for (const s of sizes) histAdd(h, s);
    sizes.sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.99]) {
      const exact = sizes[Math.ceil(q * sizes.length) - 1];
      expect(Math.abs(histQuantile(h, q)! - exact) / exact).toBeLessThan(0.011);
    }
    // ~2,000 buckets cover 1 byte to a terabyte: memory doesn't grow with file count.
    expect(Object.keys(h.buckets).length).toBeLessThan(2000);
  });

  it("merging two reservoirs keeps the sample uniform over both populations", () => {
    const rng = mulberry32(7);
    let fromB = 0;
    const trials = 400;
    for (let t = 0; t < trials; t++) {
      const a: Reservoir = { seen: 0, items: [] };
      const b: Reservoir = { seen: 0, items: [] };
      for (let i = 0; i < 1000; i++) reservoirAdd(a, { relPath: "A", absPath: "", size: 0 }, 50, rng);
      for (let i = 0; i < 3000; i++) reservoirAdd(b, { relPath: "B", absPath: "", size: 0 }, 50, rng);
      const m = reservoirMerge(a, b, 50, rng);
      expect(m.items).toHaveLength(50);
      expect(m.seen).toBe(4000);
      fromB += m.items.filter((x) => x.relPath === "B").length;
    }
    // B is 75% of the union.
    expect(fromB / (trials * 50)).toBeGreaterThan(0.73);
    expect(fromB / (trials * 50)).toBeLessThan(0.77);
  });

  it("examines every page of a short PDF, an even spread of a long one", () => {
    expect(pagesToExamine(3)).toEqual([1, 2, 3]);
    const spread = pagesToExamine(1000, 5);
    expect(spread).toEqual([1, 250, 500, 750, 1000]);
  });
});

function buildTree() {
  const lib = path.join(root, "lib");
  let made = 0;
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 2; c++) {
        const dir = path.join(lib, `a${a}`, `b${b}`, `c${c}`, "deep", "deeper");
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 5; i++) {
          fs.writeFileSync(path.join(dir, `f${i}.pdf`), "%PDF-1.4\n" + "x".repeat(100 * (i + 1)));
          fs.writeFileSync(path.join(path.dirname(path.dirname(dir)), `note${i}.txt`), "note".repeat(i + 1));
          made += 2;
        }
      }
      fs.writeFileSync(path.join(lib, `a${a}`, `b${b}`, "huge.pdf"), "%PDF-1.4\n" + "y".repeat(5000));
      made++;
    }
  }
  fs.writeFileSync(path.join(lib, "top.docx"), "doc");
  fs.mkdirSync(path.join(lib, ".Trashes"));
  fs.writeFileSync(path.join(lib, ".Trashes", "gone.pdf"), "%PDF-");
  return { lib, made };
}

describe("scanInventory", () => {
  const settings = (lib: string): ScanSettings => ({
    root: lib,
    include: DEFAULT_INCLUDES,
    exclude: DEFAULT_EXCLUDES,
    crossDevice: false,
    maxFileBytes: 4000,
    sampleSize: 10,
    seed: 5,
  });

  it("counts files and bytes by type, PDFs and their sizes, too-large and excluded, and keeps a fixed-size sample", async () => {
    const { lib } = buildTree();
    const r = await scanInventory(settings(lib), path.join(root, "cp.json"));
    expect(r.complete).toBe(true);
    const t = r.tally;
    expect(t.pdfs.files).toBe(4 * 3 * 2 * 5);
    expect(t.skipped["too-large"]).toBe(12);
    expect(t.byType.pdf.files).toBe(120 + 12);
    expect(t.byType.txt.files).toBe(4 * 3 * 2 * 5);
    expect(t.byType.docx.files).toBe(1);
    expect(t.excluded).toBe(1);
    expect(t.files).toBe(120 + 12 + 120 + 1);
    expect(t.sample.items).toHaveLength(10);
    expect(t.sample.seen).toBe(120);
    expect(t.pdfs.largest[0].size).toBe(509);
    expect(r.scanSeconds).toBeGreaterThanOrEqual(0);
  });

  it("stop and rerun: the resumed totals equal an uninterrupted scan's exactly", async () => {
    const { lib } = buildTree();
    const full = await scanInventory(settings(lib), path.join(root, "full.json"));

    const cp = path.join(root, "cp.json");
    const ac = new AbortController();
    let finishedDirs = 0;
    const first = await scanInventory(settings(lib), cp, {
      signal: ac.signal,
      saveEveryMs: 0,
      onProgress: () => {
        if (++finishedDirs === 7) ac.abort();
      },
    });
    expect(first.complete).toBe(false);
    expect(first.tally.files).toBeLessThan(full.tally.files);

    const resumed = await scanInventory(settings(lib), cp);
    expect(resumed.complete).toBe(true);
    expect(resumed.resumed).toBe(true);
    expect(resumed.runs).toBe(2);
    const strip = (t: typeof full.tally) => ({ ...t, sample: t.sample.seen, skippedExamples: Object.keys(t.skippedExamples).sort(), pdfs: { ...t.pdfs, largest: t.pdfs.largest.map((l) => l.size) } });
    expect(strip(resumed.tally)).toEqual(strip(full.tally));
    expect(resumed.tally.sample.items).toHaveLength(10);

    // A completed scan reruns instantly from its checkpoint.
    const again = await scanInventory(settings(lib), cp);
    expect(again.thisRunSeconds).toBe(0);
    expect(again.tally.files).toBe(full.tally.files);
  });

  it("a checkpoint for different settings is ignored", async () => {
    const { lib } = buildTree();
    const cp = path.join(root, "cp.json");
    await scanInventory(settings(lib), cp);
    const other = await scanInventory({ ...settings(lib), maxFileBytes: 1e9 }, cp);
    expect(other.resumed).toBe(false);
    expect(other.tally.skipped["too-large"]).toBeUndefined();
  });
});

describe.skipIf(skipOcr)("sample analysis and projection (real PDFs)", () => {
  it("measures pages, OCR share, OCR speed and index size, discards everything, and projects", async () => {
    const work = path.join(root, "work");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(work);
    fs.mkdirSync(tmp);
    const files = [
      { name: "text.pdf", pages: [{ lines: ["A text page with more than enough characters to be a real layer."] }, { lines: ["Another long enough text page, with words."] }] },
      { name: "scan.pdf", pages: [{ imageWords: "SCANNED PAGE" }] },
      { name: "mixed.pdf", pages: [{ lines: ["Text on page one, long enough to count properly here."] }, { imageWords: "PICTURE" }, { lines: ["Third page also with a decent amount of text."] }] },
    ];
    for (const f of files) await makePdf(path.join(root, f.name), f.pages, work);
    const sample = files.map((f) => ({ relPath: f.name, absPath: path.join(root, f.name), size: fs.statSync(path.join(root, f.name)).size }));

    const config = { concurrency: 4, pageTimeoutMs: 60_000, ocrLang: "eng", ocrDpi: 150, ocrPages: "auto" as const };
    const a = await analyzeSample(sample, config, tmp, { ocrPagesToTime: 5 });
    expect(a.findings.map((f) => [f.relPath, f.pages, f.examined, f.flagged])).toEqual([
      ["text.pdf", 2, 2, 0],
      ["scan.pdf", 1, 1, 1],
      ["mixed.pdf", 3, 3, 1],
    ]);
    expect(a.ocrTiming?.pages).toBe(2);
    expect(a.ocrTiming!.pagesPerSecond).toBeGreaterThan(0);
    expect(a.indexBytesPerChar).toBeGreaterThan(0);
    // Nothing kept: no rendered pages, no probe index.
    expect(fs.readdirSync(tmp)).toEqual([]);

    const tally = { pdfs: { files: 3000 } } as Parameters<typeof project>[0];
    const p = project(tally, a, 4);
    expect(p.meanPagesPerPdf).toBe(2);
    expect(p.totalPages).toBe(6000);
    expect(p.ocrShare).toBeCloseTo(2 / 6);
    expect(p.ocrPages).toBeCloseTo(2000);
    expect(p.indexingHours).toBeGreaterThan(0);
    expect(p.indexBytes).toBeGreaterThan(0);
    expect(p.diskNeededBytes).toBeGreaterThan(p.indexBytes!);

    const report = renderReport({
      root: "/Volumes/Library",
      dataDir: "/Volumes/SSD/locus-data/library/inventory",
      generatedAt: "2026-10-23T00:00:00.000Z",
      scan: {
        tally: { ...(await scanInventory({ root, include: DEFAULT_INCLUDES, exclude: DEFAULT_EXCLUDES, crossDevice: false, maxFileBytes: 1e9, sampleSize: 3, seed: 1 }, path.join(root, "cp.json"))).tally },
        complete: true,
        scanSeconds: 12,
        thisRunSeconds: 12,
        resumed: false,
        runs: 1,
      },
      analysis: a,
      projection: p,
      sampleSeconds: 3,
      config: { ...config, maxFileBytes: 500 * 1024 * 1024 },
    });
    expect(report).toContain("Scan: complete, took 12s in total.");
    expect(report).toContain("| PDFs | 3,000 |");
    expect(report).toContain("| Pages | 6,000");
    expect(report).toContain("Pages needing OCR (flagged");
    expect(report).toContain("text discarded, nothing cached");
  }, 120_000);
});
