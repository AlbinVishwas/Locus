/**
 * npm run bench:library [-- --pages 1000000] [--pages-per-doc 66] [--no-route] [--keep]
 *
 * The scale benchmark for the document library: builds a synthetic library
 * index of --pages pages (default 1,000,000) under data/locus-data-bench/,
 * straight through the library's real write path (beginDocument / writePages:
 * normalisation, FTS5 trigram exact + loose) in 25-page chunks, and measures
 * search at 250k, 500k and the full size so the curve (not a single point)
 * can be extrapolated to ~50,000 documents (~3.3M pages).
 *
 * Text is generated, deterministic (seeded), with a Zipf-like word-frequency
 * curve, numbers and codes ("26-2080"), punctuation and Hindi, ~2,400
 * characters a page, so rare / typical / common queries behave like real
 * tender text. Every page also carries a unique code (BENCH<doc>P<page>Q).
 *
 * Query classes (>= 100 queries each; their actual page counts are tracked
 * during the build, not guessed): rare (< 100 pages), typical (300-5,000),
 * common (>= 10% of all pages), short (3 characters). Each is measured as a
 * first window (50 hits + the exact count within its 300 ms budget) through
 * librarySearch, and as a deep "show more" (cursor several windows in). At the
 * full size the same queries also go through POST /api/library/search on a
 * real `next start` (run `npm run build` first; skip with --no-route).
 *
 * Space: it refuses to start if the index would cross the library cap or the
 * free-space reserve, records `df` before and after, and deletes the
 * synthetic index at the end (--keep to look at it), printing the space freed.
 *
 * Output: a table on screen and data/bench-library-report.json.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { loadLibraryConfig } from "../src/lib/library/config";
import { librarySearch } from "../src/lib/library/query";
import { beginDocument, markDocumentReady, openLibraryDb, writePages } from "../src/lib/library/store";
import type { ExtractedPage } from "./indexer/store";
import { seededRandom } from "./indexer/oracle";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const PAGES = option("--pages", 1_000_000);
const PAGES_PER_DOC = option("--pages-per-doc", 66); // 3.3M pages / 50k documents
const ROUTE_PORT = option("--port", 3198);
const PER_CLASS = option("--per-class", 100);
const CHUNK = 25;
const BENCH_DIR = path.resolve("data/locus-data-bench");
const REPORT = path.resolve("data/bench-library-report.json");
const DB_FILE = path.join(BENCH_DIR, "library", "library.db");
const CHECKPOINTS = [0.25, 0.5, 1].map((f) => Math.round(PAGES * f));
const GB = 1024 ** 3;

// --- text generation ---------------------------------------------------------------------------------

const VOCAB = 150_000;
const HINDI = 2_000;
const CODES = 100_000;
const WORDS_PER_PAGE = 330;

const gen = seededRandom(20260601);
const ri = (n: number) => Math.floor(gen() * n);

const SYLLABLES = ["ba", "ce", "di", "fo", "gu", "ha", "je", "ki", "lo", "mu", "na", "pe", "qui", "ro", "sa", "te", "ul", "vi", "wo", "xa", "yo", "zu", "tion", "ment", "ing", "er", "an", "or", "ex", "pro"];
function makeWord(i: number): string {
  // Deterministic and unique: the rank's digits pick syllables.
  let n = i + 1;
  let w = "";
  while (n > 0) {
    w += SYLLABLES[n % SYLLABLES.length];
    n = Math.floor(n / SYLLABLES.length);
  }
  return w.length < 3 ? w + "ex" : w;
}
const words: string[] = Array.from({ length: VOCAB }, (_, i) => makeWord(i));
const DEVA = "कखगघचछजझटठडढतथदधनपफबभमयरलवशषसह";
const MATRA = ["", "ा", "ि", "ी", "ु", "ू", "े", "ै", "ो", "ौ"];
const hindi: string[] = Array.from({ length: HINDI }, (_, i) => {
  let s = "";
  let n = i + 7;
  for (let k = 0; k < 3 + (i % 3); k++) {
    s += DEVA[n % DEVA.length] + MATRA[Math.floor(n / DEVA.length) % MATRA.length];
    n = Math.floor(n / 3) + k + 11;
  }
  return s;
});
const codes: string[] = Array.from({ length: CODES }, (_, i) => `${10 + (i % 30)}-${String(1000 + Math.floor(i / 30)).padStart(4, "0")}`);

// Zipf (s = 1) over the vocabulary via an alias table: O(1) per draw.
function aliasTable(weights: number[]): { prob: Float64Array; alias: Int32Array } {
  const n = weights.length;
  const total = weights.reduce((a, b) => a + b, 0);
  const scaled = weights.map((w) => (w * n) / total);
  const prob = new Float64Array(n);
  const alias = new Int32Array(n);
  const small: number[] = [];
  const large: number[] = [];
  scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
  while (small.length && large.length) {
    const s = small.pop()!;
    const l = large.pop()!;
    prob[s] = scaled[s];
    alias[s] = l;
    scaled[l] = scaled[l] + scaled[s] - 1;
    (scaled[l] < 1 ? small : large).push(l);
  }
  for (const i of [...small, ...large]) prob[i] = 1;
  return { prob, alias };
}
const zipf = aliasTable(Array.from({ length: VOCAB }, (_, i) => 1 / (i + 1)));
const draw = (): number => {
  const i = Math.floor(gen() * VOCAB);
  return gen() < zipf.prob[i] ? i : zipf.alias[i];
};

// Candidate query terms: their page counts are tracked while building.
interface Candidate {
  text: string;
  kind: "word" | "code" | "phrase" | "page";
  /** vocabulary / code index, for the page-level counter */
  idx: number;
  secondIdx?: number;
}
const candidates: Candidate[] = [];
const wordCand = new Int32Array(VOCAB).fill(-1);
const codeCand = new Int32Array(CODES).fill(-1);
{
  // Words spread over every rank band (log-uniform), so every frequency class has members.
  const seen = new Set<number>();
  for (let k = 0; k < 9000; k++) {
    const rank = Math.min(VOCAB - 1, Math.floor(Math.exp(gen() * Math.log(VOCAB))));
    if (seen.has(rank)) continue;
    seen.add(rank);
    wordCand[rank] = candidates.length;
    candidates.push({ text: words[rank], kind: "word", idx: rank });
  }
  for (let k = 0; k < 4000; k++) {
    const idx = ri(CODES);
    if (codeCand[idx] !== -1) continue;
    codeCand[idx] = candidates.length;
    candidates.push({ text: codes[idx], kind: "code", idx });
  }
}
const candCount = new Int32Array(candidates.length);
const candStamp = new Int32Array(candidates.length).fill(-1);
let pageSerial = 0;
function touch(c: number): void {
  if (candStamp[c] !== pageSerial) {
    candStamp[c] = pageSerial;
    candCount[c]++;
  }
}

function pageText(doc: number, page: number): string {
  pageSerial++;
  const out: string[] = [];
  for (let w = 0; w < WORDS_PER_PAGE; w++) {
    const r = gen();
    if (r < 0.02) {
      const ci = ri(CODES);
      out.push(codes[ci]);
      if (codeCand[ci] !== -1) touch(codeCand[ci]);
    } else if (r < 0.05) {
      out.push(hindi[Math.floor(Math.pow(gen(), 2.2) * HINDI)]);
    } else {
      const wi = draw();
      let t = words[wi];
      if (wordCand[wi] !== -1) touch(wordCand[wi]);
      const p = gen();
      if (p < 0.06) t += ",";
      else if (p < 0.1) t += ".";
      else if (p < 0.11) t += ";";
      out.push(t);
    }
  }
  out.push(`BENCH${doc}P${page}Q`);
  return out.join(" ");
}

// --- measuring ------------------------------------------------------------------------------------------

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (n: number) => Math.round(n * 10) / 10;

interface ClassStats {
  queries: number;
  firstP50: number;
  firstP95: number;
  firstMax: number;
  deepP50: number;
  deepP95: number;
  deepMax: number;
  /** Share of first windows whose count stopped at its time budget ("at least N"). */
  countBudgetHit: number;
  medianPages: number;
}

type Classes = Record<"rare" | "typical" | "common" | "short", string[]>;

function classify(totalPages: number): Classes {
  const rare: string[] = [];
  const typical: string[] = [];
  const common: string[] = [];
  for (const [i, c] of candidates.entries()) {
    const n = candCount[i];
    if (n >= 1 && n < 100) rare.push(c.text);
    else if (n >= 300 && n <= 5000) typical.push(c.text);
    else if (n >= totalPages * 0.1) common.push(c.text);
  }
  // 3-character queries: the shortest the library takes. Pieces of frequent and of odd words.
  const short: string[] = [];
  const seen = new Set<string>();
  for (let r = 0; short.length < PER_CLASS && r < 4000; r++) {
    const w = words[Math.min(VOCAB - 1, Math.floor(Math.pow(gen(), 3) * 3000))];
    const s = w.slice(0, 3);
    if (s.length === 3 && !seen.has(s)) {
      seen.add(s);
      short.push(s);
    }
  }
  const cap = (xs: string[]) => xs.slice(0, Math.max(PER_CLASS, Math.min(xs.length, PER_CLASS)));
  return { rare: cap(rare), typical: cap(typical), common: cap(common), short };
}

function measureDirect(db: Database.Database, queries: string[]): ClassStats {
  const first: number[] = [];
  const deep: number[] = [];
  const pagesFound: number[] = [];
  let budgetHit = 0;
  for (const q of queries) {
    const t0 = performance.now();
    const out = librarySearch(db, q, { mode: "exact" });
    first.push(performance.now() - t0);
    if (out.status !== "ok") continue;
    if (out.result.counts) {
      pagesFound.push(out.result.counts.pages);
      if (!out.result.counts.complete) budgetHit++;
    }
    // A deep "show more": the window after three others, when the query has that many hits.
    let cursor = out.result.nextCursor;
    for (let k = 0; k < 3 && cursor !== null; k++) {
      const next = librarySearch(db, q, { mode: "exact", cursor });
      cursor = next.status === "ok" ? next.result.nextCursor : null;
    }
    if (cursor !== null) {
      const t1 = performance.now();
      librarySearch(db, q, { mode: "exact", cursor });
      deep.push(performance.now() - t1);
    }
  }
  return {
    queries: queries.length,
    firstP50: round(pct(first, 50)),
    firstP95: round(pct(first, 95)),
    firstMax: round(Math.max(...first, 0)),
    deepP50: round(pct(deep, 50)),
    deepP95: round(pct(deep, 95)),
    deepMax: round(Math.max(...deep, 0)),
    countBudgetHit: queries.length ? round((budgetHit / queries.length) * 100) : 0,
    medianPages: pct(pagesFound, 50),
  };
}

async function measureRoute(base: string, cookie: string, queries: string[]): Promise<{ p50: number; p95: number; max: number }> {
  const times: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const res = await fetch(`${base}/api/library/search`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ message: q }) });
    await res.text();
    times.push(performance.now() - t0);
  }
  return { p50: round(pct(times, 50)), p95: round(pct(times, 95)), max: round(Math.max(...times, 0)) };
}

// --- the run -----------------------------------------------------------------------------------------

function df(dir: string): { freeBytes: number } {
  const out = execFileSync("df", ["-k", dir], { encoding: "utf8" }).trim().split("\n").pop()!.split(/\s+/);
  return { freeBytes: Number(out[3]) * 1024 };
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) total += st.blocks * 512;
    } catch {
      // vanished
    }
  }
  return total;
}

interface CheckpointReport {
  pages: number;
  documents: number;
  libraryDbBytes: number;
  bytesPerPage: number;
  classes: Record<string, ClassStats>;
  route?: Record<string, { p50: number; p95: number; max: number }>;
  buildPagesPerSecond: number;
}

async function main() {
  const config = loadLibraryConfig();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const before = df(path.resolve("data"));
  // Estimate: ~20 KB a page, with headroom. Refuse before writing a byte if that would cross a limit.
  const estimate = PAGES * 20 * 1024 * 1.25;
  if (estimate > config.maxBytes) throw new Error(`Building ${PAGES.toLocaleString()} pages needs about ${(estimate / GB).toFixed(0)} GB: more than the library cap (${(config.maxBytes / GB).toFixed(0)} GB).`);
  if (before.freeBytes - estimate < config.minFreeBytes) {
    throw new Error(`Only ${(before.freeBytes / GB).toFixed(1)} GB free: building the index (about ${(estimate / GB).toFixed(0)} GB) would leave less than the ${(config.minFreeBytes / GB).toFixed(0)} GB reserve.`);
  }
  console.log(`[bench] ${PAGES.toLocaleString()} pages, ${PAGES_PER_DOC} per document, into ${BENCH_DIR}`);
  console.log(`[bench] free before: ${(before.freeBytes / GB).toFixed(2)} GB (limit check: needs about ${(estimate / GB).toFixed(0)} GB, keeps ${(config.minFreeBytes / GB).toFixed(0)} GB free)`);

  fs.writeFileSync(path.join(BENCH_DIR, ".locus-data-dir"), JSON.stringify({ volumeUuid: "BENCH", createdAt: "x", version: 1 }));
  const db = openLibraryDb(DB_FILE);
  db.pragma("synchronous = OFF"); // build only; the search measurements run on a separate read-only connection
  let docs = 0;
  let pagesDone = 0;
  const reports: CheckpointReport[] = [];
  let routeServer: ChildProcess | null = null;
  const buildStart = performance.now();
  let nextCheckpoint = 0;

  const runCheckpoint = async (final: boolean) => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    const reader = new Database(DB_FILE, { readonly: true });
    const classes = classify(pagesDone);
    const stats: Record<string, ClassStats> = {};
    for (const [name, qs] of Object.entries(classes)) {
      if (qs.length === 0) continue;
      // Run twice and report the second pass: the first warms the file cache, as the app's own first searches do.
      measureDirect(reader, qs.slice(0, 10));
      stats[name] = measureDirect(reader, qs);
    }
    const bytes = fs.statSync(DB_FILE).size;
    const report: CheckpointReport = {
      pages: pagesDone,
      documents: docs,
      libraryDbBytes: bytes,
      bytesPerPage: Math.round(bytes / pagesDone),
      classes: stats,
      buildPagesPerSecond: Math.round(pagesDone / ((performance.now() - buildStart) / 1000)),
    };
    const counts = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, v.length]));
    console.log(`\n[bench] ${pagesDone.toLocaleString()} pages · ${docs.toLocaleString()} docs · library.db ${(bytes / GB).toFixed(2)} GB (${report.bytesPerPage.toLocaleString()} bytes/page) · queries per class ${JSON.stringify(counts)}`);
    for (const [name, s] of Object.entries(stats)) {
      console.log(`  ${name.padEnd(8)} first window p50 ${s.firstP50} ms · p95 ${s.firstP95} ms · max ${s.firstMax} ms · count hit its budget ${s.countBudgetHit}% · deep p50 ${s.deepP50} ms · p95 ${s.deepP95} ms (median ${s.medianPages.toLocaleString()} pages)`);
    }
    if (final && !flag("--no-route")) {
      try {
        const env = {
          ...process.env,
          PORT: String(ROUTE_PORT),
          LOCUS_LIBRARY_ENABLED: "true",
          LOCUS_DATA_DIR: BENCH_DIR,
          LOCUS_PASSCODE: "bench-passcode",
          SESSION_SECRET: "bench-session-secret-bench-session-secret",
        } as NodeJS.ProcessEnv;
        delete env.LOCUS_USERS_ENABLED;
        routeServer = spawn("npx", ["next", "start", "-p", String(ROUTE_PORT)], { env, stdio: "ignore" });
        const base = `http://localhost:${ROUTE_PORT}`;
        for (let i = 0; ; i++) {
          try {
            if ((await fetch(`${base}/login`)).ok) break;
          } catch {
            // not up yet
          }
          if (i > 120) throw new Error("the benchmark server didn't start (run `npm run build` first)");
          await new Promise((r) => setTimeout(r, 500));
        }
        const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: "bench-passcode" }) });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
        report.route = {};
        for (const [name, qs] of Object.entries(classes)) {
          if (qs.length === 0) continue;
          await measureRoute(base, cookie, qs.slice(0, 10));
          report.route[name] = await measureRoute(base, cookie, qs);
          console.log(`  via POST /api/library/search · ${name.padEnd(8)} p50 ${report.route[name].p50} ms · p95 ${report.route[name].p95} ms · max ${report.route[name].max} ms`);
        }
      } finally {
        routeServer?.kill("SIGTERM");
      }
    }
    // Why 1-2 character queries are refused: a full scan of a slice, extrapolated to the whole library.
    if (final) {
      const t0 = performance.now();
      const slice = 20_000;
      const hit = reader.prepare("SELECT count(*) FROM (SELECT body FROM texts LIMIT ?) WHERE body LIKE '%ab%'").pluck().get(slice) as number;
      const sliceMs = performance.now() - t0;
      const refusedStart = performance.now();
      librarySearch(reader, "ab", { mode: "exact" });
      const refusedMs = performance.now() - refusedStart;
      const extrapolated = (sliceMs / slice) * pagesDone * 2; // two readings per page at most
      console.log(`\n[bench] a 2-character query is refused in ${round(refusedMs)} ms. Scanning for it instead: ${round(sliceMs)} ms for ${slice.toLocaleString()} texts (${hit} hits) -> about ${Math.round(extrapolated / 1000)} s for the whole library.`);
      (report as CheckpointReport & { twoCharScan?: object }).twoCharScan = { sliceTexts: slice, sliceMs: round(sliceMs), extrapolatedSeconds: Math.round(extrapolated / 1000), refusedMs: round(refusedMs) };
    }
    reader.close();
    reports.push(report);
  };

  while (pagesDone < PAGES) {
    const doc = docs++;
    const n = Math.min(PAGES_PER_DOC, PAGES - pagesDone);
    const id = beginDocument(db, {
      sourceId: "folder:bench",
      key: `bench/doc-${doc}.pdf`,
      displayName: `bench/doc-${doc}.pdf`,
      sizeBytes: n * 2400,
      modifiedAt: null,
      sha256: `bench-${doc}`,
      pageCount: n,
      ocrLang: "eng",
      settings: "bench",
      encryption: null,
      scanId: 1,
    });
    for (let p0 = 0; p0 < n; p0 += CHUNK) {
      const chunk: ExtractedPage[] = [];
      for (let p = p0; p < Math.min(n, p0 + CHUNK); p++) {
        chunk.push({ pageNo: p + 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: pageText(doc, p + 1), ocrText: null, error: null });
      }
      writePages(db, id, chunk);
    }
    markDocumentReady(db, id);
    pagesDone += n;
    if (docs % 200 === 0) {
      const secs = (performance.now() - buildStart) / 1000;
      process.stdout.write(`\r[bench] building: ${pagesDone.toLocaleString()} / ${PAGES.toLocaleString()} pages · ${Math.round(pagesDone / secs)} pages/s · ${(dirBytes(BENCH_DIR) / GB).toFixed(2)} GB   `);
    }
    if (nextCheckpoint < CHECKPOINTS.length && pagesDone >= CHECKPOINTS[nextCheckpoint]) {
      process.stdout.write("\n");
      await runCheckpoint(nextCheckpoint === CHECKPOINTS.length - 1);
      nextCheckpoint++;
    }
  }
  if (nextCheckpoint < CHECKPOINTS.length) await runCheckpoint(true);

  // Where the bytes are.
  const sizes: Record<string, number> = {};
  try {
    const r = db.prepare("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 12").all() as Array<{ name: string; bytes: number }>;
    for (const x of r) sizes[x.name] = x.bytes;
  } catch {
    // dbstat isn't compiled in
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const afterBuild = df(path.resolve("data"));

  const last = reports[reports.length - 1];
  const projection = project(reports);
  console.log("\n[bench] projection for 50,000 documents (~3.3M pages):");
  console.log(`  library.db ≈ ${(projection.bytes / GB).toFixed(1)} GB (${last.bytesPerPage.toLocaleString()} bytes/page)`);
  for (const [name, v] of Object.entries(projection.p95)) console.log(`  ${name.padEnd(8)} first-window p95 ≈ ${v} ms (linear fit over 250k/500k/1M)`);

  const out = { generatedAt: new Date().toISOString(), pages: PAGES, pagesPerDoc: PAGES_PER_DOC, reports, projection, tableBytes: sizes, freeBeforeBytes: before.freeBytes, freeAfterBuildBytes: afterBuild.freeBytes };
  fs.writeFileSync(REPORT, JSON.stringify(out, null, 2));
  console.log(`[bench] report: ${REPORT}`);

  if (!flag("--keep")) {
    const size = dirBytes(BENCH_DIR);
    fs.rmSync(BENCH_DIR, { recursive: true, force: true });
    const afterDelete = df(path.resolve("data"));
    console.log(`\n[bench] deleted ${BENCH_DIR}: ${(size / GB).toFixed(2)} GB on disk. Free space: ${(before.freeBytes / GB).toFixed(2)} GB before, ${(afterBuild.freeBytes / GB).toFixed(2)} GB with the index, ${(afterDelete.freeBytes / GB).toFixed(2)} GB after deleting it (${((afterDelete.freeBytes - afterBuild.freeBytes) / GB).toFixed(2)} GB freed).`);
    (out as Record<string, unknown>).freeAfterDeleteBytes = afterDelete.freeBytes;
    fs.writeFileSync(REPORT, JSON.stringify(out, null, 2));
  }
}

/** Straight-line fits through the checkpoints, extended to 3.3M pages. Search time grows with how many pages match, so this is the pessimistic reading. */
function project(reports: CheckpointReport[]): { bytes: number; p95: Record<string, number> } {
  const target = 3_300_000;
  const fit = (pts: Array<[number, number]>) => {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
    const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1;
    const slope = num / den;
    return my + slope * (target - mx);
  };
  const p95: Record<string, number> = {};
  for (const name of Object.keys(reports[reports.length - 1].classes)) {
    const pts = reports.filter((r) => r.classes[name]).map((r) => [r.pages, r.classes[name].firstP95] as [number, number]);
    if (pts.length >= 2) p95[name] = round(Math.max(fit(pts), pts[pts.length - 1][1]));
  }
  return { bytes: fit(reports.map((r) => [r.pages, r.libraryDbBytes] as [number, number])), p95 };
}

main().catch((err) => {
  console.error(`\n[bench] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
