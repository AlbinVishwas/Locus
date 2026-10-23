import fs from "node:fs";
import path from "node:path";
import { createLimiter } from "../../../scripts/indexer/exec";
import { inkFraction, parsePgm, planPage } from "../../../scripts/indexer/classify";
import { loadConfig } from "../../../scripts/indexer/config";
import { imageCoverage, ocrImage, renderGray, renderPng, textLayerPage } from "../../../scripts/indexer/pdf";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import type { LibraryConfig } from "./config";
import { inspectPdf } from "./extract";
import { mulberry32 } from "./pipeline";
import { formatBytes, formatDuration } from "./progress";
import { SourceFileError } from "./sources/types";
import { openLibraryDb, writePages, beginDocument } from "./store";
import { walk, extensionOf, type SkipReason } from "./walk";

/**
 * `npm run library:inventory`: what's in the library folder, and what
 * indexing all of it would take -- without indexing anything.
 *
 * Phase 1, the scan: every file is counted (by type and size), every PDF's
 * size goes into a histogram, and a uniform random sample of PDFs is kept
 * (reservoir sampling). Constant memory whatever the folder holds:
 *   - sizes go into fixed log-scale buckets (~1% wide), not a list
 *   - file types are a table capped at 1,000 distinct extensions
 *   - the sample is `sampleSize` entries
 * Safe to stop and rerun: counts are committed per finished folder (down to
 * depth 3), and a checkpoint records which folders are finished. A rerun
 * skips those and redoes only the folder that was interrupted, so nothing
 * is counted twice.
 *
 * Phase 2, the sample: for each sampled PDF, page count and which pages
 * would need OCR (text layer + image coverage + blank check, the same
 * classification the indexer uses, no OCR). Then ~20 of those flagged pages
 * are OCR'd once, only to time it -- their text is discarded, nothing is
 * cached -- and the sampled text goes into a throwaway index in the temp
 * folder to measure index bytes per page. Then the projection.
 */

// --- constant-memory building blocks --------------------------------------------

const BUCKET_BASE = 1.01;
const MAX_EXTENSIONS = 1000;

export interface Histogram {
  /** bucket index -> count. Bucket i holds sizes in [1.01^i, 1.01^(i+1)). Bucket -1 holds 0-byte files. */
  buckets: Record<string, number>;
  count: number;
}

export function histAdd(h: Histogram, size: number): void {
  const i = size <= 0 ? -1 : Math.floor(Math.log(size) / Math.log(BUCKET_BASE));
  h.buckets[i] = (h.buckets[i] ?? 0) + 1;
  h.count++;
}

export function histMerge(into: Histogram, from: Histogram): void {
  for (const [k, v] of Object.entries(from.buckets)) into.buckets[k] = (into.buckets[k] ?? 0) + v;
  into.count += from.count;
}

/** The q-quantile (0..1), to within one bucket (~1%). */
export function histQuantile(h: Histogram, q: number): number | null {
  if (h.count === 0) return null;
  const target = Math.max(1, Math.ceil(q * h.count));
  let seen = 0;
  for (const k of Object.keys(h.buckets).map(Number).sort((a, b) => a - b)) {
    seen += h.buckets[k];
    if (seen >= target) return k < 0 ? 0 : Math.round(Math.pow(BUCKET_BASE, k + 0.5));
  }
  return null;
}

export interface SampledPdf {
  relPath: string;
  absPath: string;
  size: number;
}

export interface Reservoir {
  seen: number;
  items: SampledPdf[];
}

export function reservoirAdd(r: Reservoir, item: SampledPdf, k: number, rng: () => number): void {
  r.seen++;
  if (r.items.length < k) r.items.push(item);
  else {
    const j = Math.floor(rng() * r.seen);
    if (j < k) r.items[j] = item;
  }
}

/**
 * Two uniform samples of disjoint populations -> one uniform sample of
 * their union: each slot comes from A with probability (A left)/(A left + B
 * left), drawing without replacement (a hypergeometric draw).
 */
export function reservoirMerge(a: Reservoir, b: Reservoir, k: number, rng: () => number): Reservoir {
  const pa = [...a.items].sort(() => rng() - 0.5);
  const pb = [...b.items].sort(() => rng() - 0.5);
  let na = a.seen;
  let nb = b.seen;
  const items: SampledPdf[] = [];
  while (items.length < k && na + nb > 0) {
    if (rng() * (na + nb) < na) {
      const x = pa.shift();
      na--;
      if (x) items.push(x);
    } else {
      const x = pb.shift();
      nb--;
      if (x) items.push(x);
    }
  }
  return { seen: a.seen + b.seen, items };
}

export interface Tally {
  files: number;
  bytes: number;
  byType: Record<string, { files: number; bytes: number }>;
  pdfs: { files: number; bytes: number; sizes: Histogram; largest: Array<{ relPath: string; size: number }> };
  skipped: Record<string, number>;
  skippedExamples: Record<string, string[]>;
  excluded: number;
  sample: Reservoir;
}

export function emptyTally(): Tally {
  return {
    files: 0,
    bytes: 0,
    byType: {},
    pdfs: { files: 0, bytes: 0, sizes: { buckets: {}, count: 0 }, largest: [] },
    skipped: {},
    skippedExamples: {},
    excluded: 0,
    sample: { seen: 0, items: [] },
  };
}

function addType(t: Tally, ext: string, size: number): void {
  const key = ext === "" ? "(none)" : ext;
  const slot = t.byType[key] ?? (Object.keys(t.byType).length < MAX_EXTENSIONS ? (t.byType[key] = { files: 0, bytes: 0 }) : (t.byType["(other)"] ??= { files: 0, bytes: 0 }));
  slot.files++;
  slot.bytes += size;
}

function addLargest(list: Array<{ relPath: string; size: number }>, item: { relPath: string; size: number }, keep = 10): void {
  if (list.length < keep || item.size > list[list.length - 1].size) {
    list.push(item);
    list.sort((a, b) => b.size - a.size);
    if (list.length > keep) list.pop();
  }
}

export function tallyMerge(into: Tally, from: Tally, sampleSize: number, rng: () => number): void {
  into.files += from.files;
  into.bytes += from.bytes;
  for (const [ext, v] of Object.entries(from.byType)) {
    const slot = into.byType[ext] ?? (Object.keys(into.byType).length < MAX_EXTENSIONS ? (into.byType[ext] = { files: 0, bytes: 0 }) : (into.byType["(other)"] ??= { files: 0, bytes: 0 }));
    slot.files += v.files;
    slot.bytes += v.bytes;
  }
  into.pdfs.files += from.pdfs.files;
  into.pdfs.bytes += from.pdfs.bytes;
  histMerge(into.pdfs.sizes, from.pdfs.sizes);
  for (const l of from.pdfs.largest) addLargest(into.pdfs.largest, l);
  for (const [r, n] of Object.entries(from.skipped)) into.skipped[r] = (into.skipped[r] ?? 0) + n;
  for (const [r, ex] of Object.entries(from.skippedExamples)) {
    const list = (into.skippedExamples[r] ??= []);
    for (const e of ex) if (list.length < 20) list.push(e);
  }
  into.excluded += from.excluded;
  into.sample = reservoirMerge(into.sample, from.sample, sampleSize, rng);
}

// --- the scan, with checkpoints ------------------------------------------------

export const CHECKPOINT_DEPTH = 3;

export interface Checkpoint {
  version: 1;
  /** Root + patterns + limits: a checkpoint for different settings is discarded. */
  fingerprint: string;
  completedDirs: string[];
  committed: Tally;
  scanComplete: boolean;
  scanSeconds: number;
  runs: number;
}

export interface ScanSettings {
  root: string;
  include: string[];
  exclude: string[];
  crossDevice: boolean;
  maxFileBytes: number;
  sampleSize: number;
  seed: number;
}

export function fingerprintOf(s: ScanSettings): string {
  return JSON.stringify({ root: s.root, include: s.include, exclude: s.exclude, crossDevice: s.crossDevice, max: s.maxFileBytes, k: s.sampleSize, seed: s.seed });
}

export function loadCheckpoint(file: string, fingerprint: string): Checkpoint | null {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as Checkpoint;
    return c.version === 1 && c.fingerprint === fingerprint ? c : null;
  } catch {
    return null;
  }
}

/** Write to a temp name, then rename: a half-written checkpoint or report never exists. */
export function writeAtomically(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export interface ScanResult {
  tally: Tally;
  complete: boolean;
  scanSeconds: number;
  thisRunSeconds: number;
  resumed: boolean;
  runs: number;
}

export async function scanInventory(
  s: ScanSettings,
  checkpointFile: string,
  options: { signal?: AbortSignal; saveEveryMs?: number; onProgress?: (t: Tally) => void } = {}
): Promise<ScanResult> {
  const fingerprint = fingerprintOf(s);
  const prior = loadCheckpoint(checkpointFile, fingerprint);
  const rng = mulberry32(s.seed + (prior?.runs ?? 0));
  const started = Date.now();
  if (prior?.scanComplete) {
    return { tally: prior.committed, complete: true, scanSeconds: prior.scanSeconds, thisRunSeconds: 0, resumed: true, runs: prior.runs };
  }
  const committed = prior?.committed ?? emptyTally();
  const completed = new Set(prior?.completedDirs ?? []);
  const runs = (prior?.runs ?? 0) + 1;
  // One tally per open folder at depth <= CHECKPOINT_DEPTH; counts go to the deepest one.
  const open: Array<{ rel: string; depth: number; tally: Tally }> = [];
  const current = () => open[open.length - 1].tally;
  let lastSave = Date.now();
  const save = (scanComplete: boolean) => {
    const c: Checkpoint = {
      version: 1,
      fingerprint,
      completedDirs: [...completed],
      committed,
      scanComplete,
      scanSeconds: (prior?.scanSeconds ?? 0) + (Date.now() - started) / 1000,
      runs,
    };
    writeAtomically(checkpointFile, JSON.stringify(c));
    lastSave = Date.now();
  };

  const skip = (reason: SkipReason | string, relPath: string) => {
    const t = current();
    t.skipped[reason] = (t.skipped[reason] ?? 0) + 1;
    const ex = (t.skippedExamples[reason] ??= []);
    if (ex.length < 20) ex.push(relPath);
  };

  let aborted = false;
  for await (const f of walk(s.root, {
    include: s.include,
    exclude: s.exclude,
    crossDevice: s.crossDevice,
    statOthers: true,
    signal: options.signal,
    skipDir: (rel, depth) => depth >= 1 && depth <= CHECKPOINT_DEPTH && completed.has(rel),
    onDirEnter: (rel, depth) => {
      if (depth <= CHECKPOINT_DEPTH) open.push({ rel, depth, tally: emptyTally() });
    },
    onDirDone: (rel, depth) => {
      if (depth > CHECKPOINT_DEPTH) return;
      const done = open.pop()!;
      tallyMerge(committed, done.tally, s.sampleSize, rng);
      if (depth >= 1) completed.add(rel);
      if (Date.now() - lastSave > (options.saveEveryMs ?? 5000)) save(false);
      options.onProgress?.(committed);
    },
    onSkip: (sk) => {
      if (open.length === 0) open.push({ rel: "", depth: 0, tally: emptyTally() });
      skip(sk.reason, sk.relPath);
    },
    onExcluded: () => {
      current().excluded++;
    },
    onOther: (ext, size) => {
      const t = current();
      t.files++;
      t.bytes += size ?? 0;
      addType(t, ext, size ?? 0);
    },
  })) {
    const t = current();
    t.files++;
    t.bytes += f.size;
    addType(t, extensionOf(f.relPath), f.size);
    if (f.size > s.maxFileBytes) {
      skip("too-large", f.relPath);
      continue;
    }
    t.pdfs.files++;
    t.pdfs.bytes += f.size;
    histAdd(t.pdfs.sizes, f.size);
    addLargest(t.pdfs.largest, { relPath: f.relPath, size: f.size });
    reservoirAdd(t.sample, { relPath: f.relPath, absPath: f.absPath, size: f.size }, s.sampleSize, rng);
  }
  if (options.signal?.aborted) aborted = true;
  // A walk that couldn't even open the root still leaves its skip in `open`.
  if (!aborted) while (open.length > 0) tallyMerge(committed, open.pop()!.tally, s.sampleSize, rng);
  save(!aborted);
  const scanSeconds = (prior?.scanSeconds ?? 0) + (Date.now() - started) / 1000;
  return { tally: committed, complete: !aborted, scanSeconds, thisRunSeconds: (Date.now() - started) / 1000, resumed: prior !== null, runs };
}

// --- the sample ---------------------------------------------------------------------

export interface SampleFinding {
  relPath: string;
  size: number;
  pages: number | null;
  examined: number;
  flagged: number;
  blank: number;
  layerChars: number;
  textSeconds: number;
  outcome: "ok" | "encrypted" | "corrupt" | "timeout" | "other";
  encryption?: "none" | "restricted";
  flaggedPages: number[];
}

export interface SampleAnalysis {
  findings: SampleFinding[];
  ocrTiming: { pages: number; wallSeconds: number; pagesPerSecond: number; avgOcrChars: number; concurrency: number } | null;
  indexBytesPerChar: number | null;
}

const MAX_PAGES_EXAMINED = 40;

/** Pages to examine in a PDF of `n` pages: all of them, or `max` spread evenly. */
export function pagesToExamine(n: number, max = MAX_PAGES_EXAMINED): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i + 1);
  return Array.from({ length: max }, (_, i) => 1 + Math.floor((i * (n - 1)) / (max - 1)));
}

export async function analyzeSample(
  sample: SampledPdf[],
  config: Pick<LibraryConfig, "concurrency" | "pageTimeoutMs" | "ocrLang" | "ocrDpi" | "ocrPages">,
  tempDir: string,
  options: { ocrPagesToTime?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<SampleAnalysis> {
  const limit = createLimiter(config.concurrency);
  const t = loadConfig();
  let done = 0;
  const findings = await Promise.all(
    sample.map(async (pdf): Promise<SampleFinding> => {
      const finding: SampleFinding = { relPath: pdf.relPath, size: pdf.size, pages: null, examined: 0, flagged: 0, blank: 0, layerChars: 0, textSeconds: 0, outcome: "ok", flaggedPages: [] };
      try {
        if (options.signal?.aborted) throw new Error("aborted");
        const info = await limit(() => inspectPdf(pdf.absPath, config.pageTimeoutMs));
        finding.pages = info.pageCount;
        finding.encryption = info.encryption;
        const coverage = await limit(() => imageCoverage(pdf.absPath, info.pageAreas, config.pageTimeoutMs)).catch(() => new Array(info.pageCount).fill(1));
        const started = Date.now();
        for (const pageNo of pagesToExamine(info.pageCount)) {
          if (options.signal?.aborted) throw new Error("aborted");
          const text = await limit(() => textLayerPage(pdf.absPath, pageNo, config.pageTimeoutMs)).catch(() => "");
          const plan = planPage(text, coverage[pageNo - 1], { ...t, ocrAllPages: config.ocrPages === "all" });
          finding.examined++;
          finding.layerChars += text.replace(/\s/g, "").length;
          let blank = false;
          if (plan.checkBlank) {
            const pgm = await limit(() => renderGray(pdf.absPath, pageNo, 50, config.pageTimeoutMs)).catch(() => null);
            blank = pgm !== null && inkFraction(parsePgm(pgm)) < t.blankMaxInk;
          }
          if (blank) finding.blank++;
          else if (plan.ocrReason) {
            finding.flagged++;
            finding.flaggedPages.push(pageNo);
          }
        }
        finding.textSeconds = (Date.now() - started) / 1000;
      } catch (err) {
        if (err instanceof SourceFileError) finding.outcome = err.kind === "encrypted" ? "encrypted" : err.kind === "timeout" ? "timeout" : "corrupt";
        else finding.outcome = "other";
      }
      options.onProgress?.(++done, sample.length);
      return finding;
    })
  );

  // Time OCR on a spread of flagged pages: rendered into tempDir, text kept
  // only long enough to measure its size, then discarded. No cache.
  const want = options.ocrPagesToTime ?? 20;
  const candidates: Array<{ file: string; page: number }> = [];
  for (let round = 0; candidates.length < want; round++) {
    let added = false;
    for (const f of findings) {
      if (f.flaggedPages[round] !== undefined && candidates.length < want) {
        candidates.push({ file: sample.find((s) => s.relPath === f.relPath)!.absPath, page: f.flaggedPages[round] });
        added = true;
      }
    }
    if (!added) break;
  }
  let ocrTiming: SampleAnalysis["ocrTiming"] = null;
  const ocrTexts: string[] = [];
  if (candidates.length > 0) {
    const started = Date.now();
    await Promise.all(
      candidates.map((c, i) =>
        limit(async () => {
          const base = path.join(tempDir, `ocr-timing-${i}`);
          try {
            const png = await renderPng(c.file, c.page, config.ocrDpi, base, config.pageTimeoutMs);
            ocrTexts.push(await ocrImage(png, config.ocrLang, config.pageTimeoutMs));
          } catch {
            // a page that fails to OCR doesn't count toward the timing
          } finally {
            fs.rmSync(`${base}.png`, { force: true });
          }
        })
      )
    );
    const wall = (Date.now() - started) / 1000;
    ocrTiming = {
      pages: ocrTexts.length,
      wallSeconds: wall,
      pagesPerSecond: ocrTexts.length / Math.max(wall, 0.001),
      avgOcrChars: ocrTexts.length ? ocrTexts.reduce((s, x) => s + x.replace(/\s/g, "").length, 0) / ocrTexts.length : 0,
      concurrency: config.concurrency,
    };
  }

  // Index bytes per character of text, measured on a throwaway library index.
  let indexBytesPerChar: number | null = null;
  const probeFile = path.join(tempDir, "size-probe.db");
  try {
    const db = openLibraryDb(probeFile);
    db.pragma("synchronous = OFF");
    let chars = 0;
    const docId = beginDocument(db, { sourceId: "probe", key: "probe", displayName: "probe", sizeBytes: 0, modifiedAt: null, sha256: "probe", pageCount: 0, ocrLang: config.ocrLang, settings: "probe", encryption: null, scanId: null });
    const pages: ExtractedPage[] = [];
    let pageNo = 1;
    for (const f of findings) {
      if (f.outcome !== "ok") continue;
      const pdf = sample.find((s) => s.relPath === f.relPath)!;
      for (const p of pagesToExamine(f.pages ?? 0).slice(0, 10)) {
        const text = await limit(() => textLayerPage(pdf.absPath, p, config.pageTimeoutMs)).catch(() => "");
        chars += text.replace(/\s/g, "").length;
        pages.push({ pageNo: pageNo++, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: text, ocrText: null, error: null });
      }
    }
    for (const text of ocrTexts) {
      chars += text.replace(/\s/g, "").length;
      pages.push({ pageNo: pageNo++, pageLabel: null, source: "ocr", ocrReason: "no-text-layer", imageCoverage: 0, layerText: "", ocrText: text, error: null });
    }
    if (pages.length > 0 && chars > 0) {
      // Bytes actually used in the database's pages (dbstat), before and
      // after: file size alone can't see rows that fit into pages the empty
      // schema already had.
      const used = () => Number(db.prepare("SELECT sum(pgsize - unused) FROM dbstat").pluck().get());
      const baseline = used();
      writePages(db, docId, pages);
      indexBytesPerChar = (used() - baseline) / chars;
    }
    db.close();
  } finally {
    for (const f of fs.readdirSync(tempDir)) if (f.startsWith("size-")) fs.rmSync(path.join(tempDir, f), { force: true });
  }

  return { findings, ocrTiming, indexBytesPerChar };
}

// --- projection and report ---------------------------------------------------------------

export interface Projection {
  pdfs: number;
  meanPagesPerPdf: number | null;
  pagesCi95: [number, number] | null;
  totalPages: number | null;
  ocrShare: number | null;
  ocrPages: number | null;
  textSecondsPerPage: number | null;
  indexingHours: number | null;
  indexBytes: number | null;
  ocrCacheBytes: number | null;
  diskNeededBytes: number | null;
}

export function project(tally: Tally, analysis: SampleAnalysis, concurrency: number, headroomBytes = 20 * 1024 ** 3): Projection {
  const ok = analysis.findings.filter((f) => f.outcome === "ok" && f.pages !== null);
  const pdfs = tally.pdfs.files;
  if (ok.length === 0) {
    return { pdfs, meanPagesPerPdf: null, pagesCi95: null, totalPages: null, ocrShare: null, ocrPages: null, textSecondsPerPage: null, indexingHours: null, indexBytes: null, ocrCacheBytes: null, diskNeededBytes: null };
  }
  const pages = ok.map((f) => f.pages!);
  const mean = pages.reduce((a, b) => a + b, 0) / pages.length;
  const sd = Math.sqrt(pages.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, pages.length - 1));
  const half = (1.96 * sd) / Math.sqrt(pages.length);
  // Only the readable share of PDFs will actually be indexed.
  const readableShare = ok.length / analysis.findings.length;
  const totalPages = pdfs * readableShare * mean;
  const examined = ok.reduce((a, f) => a + f.examined, 0);
  const flagged = ok.reduce((a, f) => a + f.flagged, 0);
  const ocrShare = examined > 0 ? flagged / examined : 0;
  const ocrPages = totalPages * ocrShare;
  const textSecondsPerPage = examined > 0 ? ok.reduce((a, f) => a + f.textSeconds, 0) / examined : 0;
  const ocrSeconds = analysis.ocrTiming && analysis.ocrTiming.pagesPerSecond > 0 ? ocrPages / analysis.ocrTiming.pagesPerSecond : null;
  // Text extraction ran with `concurrency` processes in parallel while timing; per page it's the sequential cost spread across them.
  const textSeconds = (totalPages * textSecondsPerPage) / Math.max(1, concurrency);
  const indexingHours = ocrSeconds === null ? null : (textSeconds + ocrSeconds) / 3600;
  const layerCharsPerPage = examined > 0 ? ok.reduce((a, f) => a + f.layerChars, 0) / examined : 0;
  const ocrChars = analysis.ocrTiming?.avgOcrChars ?? 0;
  const charsPerPage = layerCharsPerPage + ocrShare * ocrChars;
  const indexBytes = analysis.indexBytesPerChar === null ? null : totalPages * charsPerPage * analysis.indexBytesPerChar;
  // The OCR cache stores each OCR'd page's text once (~1 byte/char plus row overhead).
  const ocrCacheBytes = ocrPages * (ocrChars * 1.1 + 64);
  return {
    pdfs,
    meanPagesPerPdf: mean,
    pagesCi95: [Math.max(0, (mean - half) * pdfs * readableShare), (mean + half) * pdfs * readableShare],
    totalPages,
    ocrShare,
    ocrPages,
    textSecondsPerPage,
    indexingHours,
    indexBytes,
    ocrCacheBytes,
    diskNeededBytes: indexBytes === null ? null : indexBytes + ocrCacheBytes + headroomBytes,
  };
}

const n = (x: number) => Math.round(x).toLocaleString("en-US");

export function renderReport(r: {
  root: string;
  dataDir: string;
  generatedAt: string;
  scan: ScanResult;
  analysis: SampleAnalysis | null;
  projection: Projection | null;
  sampleSeconds: number | null;
  config: Pick<LibraryConfig, "concurrency" | "ocrLang" | "ocrDpi" | "ocrPages" | "maxFileBytes">;
}): string {
  const t = r.scan.tally;
  const lines: string[] = [];
  lines.push(`# Library inventory`, "", `Folder: \`${r.root}\`  `, `Generated: ${r.generatedAt}  `, `Report written to: \`${r.dataDir}\``, "");
  lines.push(
    `Scan: ${r.scan.complete ? "complete" : "**incomplete (stopped)** -- rerun to continue"}, ` +
      `took ${formatDuration(r.scan.scanSeconds)} in total${r.scan.runs > 1 ? ` over ${r.scan.runs} runs (this run ${formatDuration(r.scan.thisRunSeconds)})` : ""}.`,
    ""
  );
  lines.push(`## Files`, "", `| | Files | Size |`, `| --- | ---: | ---: |`, `| All files | ${n(t.files)} | ${formatBytes(t.bytes)} |`, `| PDFs to index (under ${formatBytes(r.config.maxFileBytes)}) | ${n(t.pdfs.files)} | ${formatBytes(t.pdfs.bytes)} |`, `| Excluded by patterns (files + folders) | ${n(t.excluded)} | |`, "");
  const types = Object.entries(t.byType).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25);
  lines.push(`### By type (top 25 by size)`, "", `| Type | Files | Size |`, `| --- | ---: | ---: |`, ...types.map(([ext, v]) => `| ${ext} | ${n(v.files)} | ${formatBytes(v.bytes)} |`), "");
  const med = histQuantile(t.pdfs.sizes, 0.5);
  const p90 = histQuantile(t.pdfs.sizes, 0.9);
  lines.push(
    `### PDF sizes`,
    "",
    `Median ${med === null ? "–" : formatBytes(med)}, p90 ${p90 === null ? "–" : formatBytes(p90)} (each within ~1%), largest ${t.pdfs.largest[0] ? formatBytes(t.pdfs.largest[0].size) : "–"}.`,
    "",
    ...t.pdfs.largest.slice(0, 10).map((l) => `- ${formatBytes(l.size)} \`${l.relPath}\``),
    ""
  );
  const skipped = Object.entries(t.skipped).sort((a, b) => b[1] - a[1]);
  lines.push(`### Skipped, and why`, "", skipped.length === 0 ? "Nothing skipped." : `| Reason | Count | Examples |\n| --- | ---: | --- |\n${skipped.map(([reason, c]) => `| ${reason} | ${n(c)} | ${(t.skippedExamples[reason] ?? []).slice(0, 3).map((e) => `\`${e}\``).join(", ")} |`).join("\n")}`, "");

  if (r.analysis && r.projection) {
    const a = r.analysis;
    const p = r.projection;
    const by = (o: string) => a.findings.filter((f) => f.outcome === o).length;
    lines.push(
      `## Sample: ${a.findings.length} random PDFs${r.sampleSeconds !== null ? ` (analysed in ${formatDuration(r.sampleSeconds)})` : ""}`,
      "",
      `Readable ${by("ok")}, encrypted (password) ${by("encrypted")}, corrupt ${by("corrupt")}, timed out ${by("timeout")}, other ${by("other")}; restricted-but-readable ${a.findings.filter((f) => f.encryption === "restricted").length}.`,
      "",
      `- Pages per PDF: mean ${p.meanPagesPerPdf?.toFixed(1)}`,
      `- Pages needing OCR (flagged: no text layer, large images, or suspect text): ${((p.ocrShare ?? 0) * 100).toFixed(1)}%`,
      `- Text extraction: ${((p.textSecondsPerPage ?? 0) * 1000).toFixed(0)} ms per page (sequential cost)`,
      a.ocrTiming
        ? `- OCR (${r.config.ocrLang} @ ${r.config.ocrDpi} DPI): ${a.ocrTiming.pages} pages in ${a.ocrTiming.wallSeconds.toFixed(1)} s with ${a.ocrTiming.concurrency} processes = ${a.ocrTiming.pagesPerSecond.toFixed(2)} pages/s (text discarded, nothing cached)`
        : `- OCR: no flagged pages in the sample to time`,
      `- Index: ${a.indexBytesPerChar === null ? "–" : `${a.indexBytesPerChar.toFixed(1)} bytes per character of text`} (measured on a throwaway index, deleted)`,
      "",
      `## Projection for the whole folder`,
      "",
      `| | Estimate |`,
      `| --- | --- |`,
      `| PDFs | ${n(p.pdfs)} |`,
      `| Pages | ${p.totalPages === null ? "–" : n(p.totalPages)}${p.pagesCi95 ? ` (95% range ${n(p.pagesCi95[0])} – ${n(p.pagesCi95[1])})` : ""} |`,
      `| Pages needing OCR (OCR_PAGES=${r.config.ocrPages}) | ${p.ocrPages === null ? "–" : n(p.ocrPages)} |`,
      `| Indexing time (${r.config.concurrency} processes) | ${p.indexingHours === null ? "–" : `${formatDuration(p.indexingHours * 3600)} (${p.indexingHours.toFixed(0)} h)`} |`,
      `| Library index on the external drive | ${p.indexBytes === null ? "–" : formatBytes(p.indexBytes)} |`,
      `| OCR cache | ${p.ocrCacheBytes === null ? "–" : formatBytes(p.ocrCacheBytes)} |`,
      `| Free space to have on the drive (index + cache + 20 GB headroom) | ${p.diskNeededBytes === null ? "–" : formatBytes(p.diskNeededBytes)} |`,
      "",
      `Estimates from a ${a.findings.length}-PDF sample; the page range is the 95% interval for the mean, not for the OCR share or speed. ` +
        `Indexing time assumes the sampled OCR speed holds for the whole run on this machine.`
    );
  }
  return lines.join("\n") + "\n";
}
