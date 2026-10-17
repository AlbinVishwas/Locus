/**
 * npm run bench [-- --pages 100000] [--readings 2] [--skip-build] [--skip-route]
 *
 * Builds a synthetic index of --pages pages (default 100,000) and measures:
 *   - index build time and database size,
 *   - search latency (p50/p95) calling search() directly,
 *   - the same queries through POST /api/search on a real `next start`
 *     server (run `npm run build` first).
 *
 * The synthetic pages are made from the real collection's text when an index
 * exists at data/index/search.db (halves of two random real pages per page),
 * so word frequencies and page lengths are realistic; otherwise from a fixed
 * vocabulary. Like the real index under OCR_PAGES=all, every page stores two
 * readings: a text layer and an "OCR" copy with ~2% character noise.
 * --readings 1 stores the text layer only, which is what most pages look
 * like under OCR_PAGES=auto. Every
 * page also carries a unique code ("BENCH<doc>P<page>Q") so there are
 * guaranteed single-hit queries. (Self-delimiting on purpose: queries are
 * trimmed, so a code like "BENCH-5/1" would also match "BENCH-5/10".)
 *
 * What it does not measure: extraction/OCR time (that is per-page work done
 * once at indexing; see the index report for real OCR throughput).
 *
 * Output: data/bench/ (gitignored) — bench.db and bench-report.txt.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { search } from "../src/lib/search/query";
import { seededRandom } from "./indexer/oracle";
import { openIndex, replaceDocument, type ExtractedPage } from "./indexer/store";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const PAGES = option("--pages", 100_000);
const READINGS = option("--readings", 2);
const PAGES_PER_DOC = 100;
const ROUTE_PORT = option("--port", 3199);
const OUT_DIR = path.resolve("data/bench");
const DB_PATH = path.join(OUT_DIR, "bench.db");
const REAL_INDEX = path.resolve("data/index/search.db");

// Separate generators for building and for queries, so every run asks the
// same queries whether or not it rebuilt the index first.
const buildRand = seededRandom(424242);
const queryRand = seededRandom(777);
let rand = buildRand;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

function sourceTexts(): string[] {
  if (fs.existsSync(REAL_INDEX)) {
    const db = new Database(REAL_INDEX, { readonly: true });
    const bodies = db
      .prepare("SELECT body FROM texts WHERE kind = 'layer' AND length(body) > 200")
      .pluck()
      .all() as string[];
    db.close();
    if (bodies.length > 0) return bodies;
  }
  const vocab =
    "tender bidder contract clause schedule amount earnest money deposit security performance bank guarantee submission technical financial evaluation eligibility criteria railway section drawing specification rate quantity item work completion period penalty damages arbitration".split(
      " "
    );
  return Array.from({ length: 2000 }, () =>
    Array.from({ length: 330 }, () => pick(vocab)).join(" ")
  );
}

function noisy(text: string): string {
  // ~2% of characters swapped for a look-alike, as OCR does.
  const swaps: Record<string, string> = { o: "0", l: "1", e: "c", a: "o", i: "l", s: "5", m: "rn" };
  let out = "";
  for (const ch of text) out += rand() < 0.02 && swaps[ch] ? swaps[ch] : ch;
  return out;
}

function buildIndex(sources: string[]) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const suffix of ["", "-journal", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });

  const db = openIndex(DB_PATH);
  const docs = Math.ceil(PAGES / PAGES_PER_DOC);
  const started = performance.now();
  let pagesWritten = 0;
  let textChars = 0;

  for (let d = 0; d < docs; d++) {
    const count = Math.min(PAGES_PER_DOC, PAGES - pagesWritten);
    const pages: ExtractedPage[] = [];
    for (let p = 1; p <= count; p++) {
      const a = pick(sources);
      const b = pick(sources);
      const layer = `${a.slice(0, a.length >> 1)} BENCH${d}P${p}Q ${b.slice(b.length >> 1)}`;
      textChars += layer.length;
      pages.push({
        pageNo: p,
        pageLabel: null,
        source: READINGS === 2 ? "text+ocr" : "text",
        ocrReason: READINGS === 2 ? "all-pages" : null,
        imageCoverage: 0,
        layerText: layer,
        ocrText: READINGS === 2 ? noisy(layer) : null,
        error: null,
      });
    }
    replaceDocument(db, {
      filename: `bench-${String(d).padStart(5, "0")}.pdf`,
      sha256: `bench-${d}`,
      sizeBytes: 0,
      pageCount: count,
      ocrLang: "eng",
      settings: "bench",
      error: null,
      pages,
    });
    pagesWritten += count;
    if ((d + 1) % 100 === 0) console.error(`  ${pagesWritten} pages written`);
  }
  db.close();

  return {
    seconds: (performance.now() - started) / 1000,
    pages: pagesWritten,
    documents: docs,
    avgPageChars: Math.round(textChars / pagesWritten),
    bytes: fs.statSync(DB_PATH).size,
  };
}

interface Query {
  text: string;
  mode: "exact" | "loose";
  category: string;
}

function querySet(sources: string[]): Query[] {
  rand = queryRand;
  const queries: Query[] = [];
  const add = (text: string, category: string, mode: "exact" | "loose" = "exact") =>
    queries.push({ text, mode, category });

  // Typical: slices of real text, 3-30 characters, as someone would paste.
  for (let i = 0; i < 300; i++) {
    const s = pick(sources);
    const len = 3 + Math.floor(rand() * 28);
    const start = Math.floor(rand() * Math.max(1, s.length - len));
    const q = s.slice(start, start + len).trim();
    if (q.length >= 3) add(q, "typical", i % 4 === 0 ? "loose" : "exact");
  }
  // Rare: exactly one page has each code.
  for (let i = 0; i < 100; i++) {
    add(`BENCH${Math.floor(rand() * (PAGES / PAGES_PER_DOC))}P${1 + Math.floor(rand() * PAGES_PER_DOC)}Q`, "rare");
  }
  // Misses.
  for (let i = 0; i < 100; i++) add(`zq${Math.floor(rand() * 1e9).toString(36)}xv`, "miss");
  // Very common: words on a large share of pages — the worst case, since
  // every matching page has to be counted.
  for (const w of ["the", "and", "tender", "shall", "bidder", "bench"]) {
    for (let r = 0; r < 5; r++) add(w, "common");
  }
  // Under 3 characters: full scan by design; reported separately.
  for (const w of ["rs", "no", "a", "%"]) for (let r = 0; r < 3; r++) add(w, "short");
  return queries;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function summarize(label: string, samples: Array<{ category: string; ms: number; hits: number }>) {
  const lines: string[] = [];
  const row = (name: string, xs: Array<{ ms: number; hits: number }>) => {
    const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
    const hits = xs.map((x) => x.hits).sort((a, b) => a - b);
    lines.push(
      `  ${name.padEnd(22)} n=${String(xs.length).padStart(4)}  p50 ${percentile(ms, 0.5).toFixed(2).padStart(8)} ms  ` +
        `p95 ${percentile(ms, 0.95).toFixed(2).padStart(8)} ms  max ${ms[ms.length - 1].toFixed(2).padStart(8)} ms  ` +
        `hits median ${percentile(hits, 0.5)} max ${hits[hits.length - 1]}`
    );
  };
  lines.push(label);
  const indexed = samples.filter((s) => s.category !== "short");
  row("ALL indexed (>=3 ch)", indexed);
  for (const c of ["typical", "rare", "miss", "common", "short"]) {
    const xs = samples.filter((s) => s.category === c);
    if (xs.length) row(c === "short" ? "short (full scan)" : c, xs);
  }
  return lines;
}

function rawLatency(queries: Query[]) {
  const db = new Database(DB_PATH, { readonly: true });
  // Warm-up: first touches read the file into the OS cache.
  for (const q of queries.slice(0, 20)) search(db, q.text, { mode: q.mode, offset: 0, limit: 50 });
  const samples = queries.map((q) => {
    const t = performance.now();
    const r = search(db, q.text, { mode: q.mode, offset: 0, limit: 50 });
    return { category: q.category, ms: performance.now() - t, hits: r.totalPages };
  });
  db.close();
  return samples;
}

async function routeLatency(queries: Query[]) {
  if (!fs.existsSync(path.resolve(".next/BUILD_ID"))) {
    throw new Error("No production build found. Run `npm run build` first, or pass --skip-route.");
  }
  const server = spawn("npx", ["next", "start", "-p", String(ROUTE_PORT)], {
    env: { ...process.env, SEARCH_INDEX_PATH: DB_PATH },
    stdio: "ignore",
  });
  const url = `http://localhost:${ROUTE_PORT}/api/search`;
  const call = async (q: Query) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q.text, mode: q.mode, limit: 50 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as { totalPages: number };
  };
  try {
    for (let i = 0; ; i++) {
      try {
        await call({ text: "warm", mode: "exact", category: "" });
        break;
      } catch {
        if (i > 120) throw new Error("next start did not come up");
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    for (const q of queries.slice(0, 20)) await call(q);
    const samples = [];
    for (const q of queries) {
      const t = performance.now();
      const r = await call(q);
      samples.push({ category: q.category, ms: performance.now() - t, hits: r.totalPages });
    }
    return samples;
  } finally {
    server.kill();
  }
}

async function main() {
  const sources = sourceTexts();
  const lines: string[] = [];
  lines.push(`BENCHMARK  ${new Date().toISOString()}  node ${process.version}`);
  lines.push(`text source: ${fs.existsSync(REAL_INDEX) ? `${sources.length} real page texts` : "fixed vocabulary"}`);

  if (!flag("--skip-build") || !fs.existsSync(DB_PATH)) {
    console.error(`Building a ${PAGES}-page synthetic index at ${DB_PATH} ...`);
    const b = buildIndex(sources);
    lines.push(
      `index build: ${b.pages} pages in ${b.documents} documents (${READINGS} reading${READINGS === 2 ? "s" : ""} per page), ` +
        `avg ${b.avgPageChars} chars/page, ${b.seconds.toFixed(1)} s, ` +
        `${(b.bytes / 1024 / 1024).toFixed(0)} MB (${((b.bytes / b.pages) / 1024).toFixed(1)} KB/page)`
    );
  } else {
    lines.push(`index: reused ${DB_PATH}, ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(0)} MB`);
  }

  const queries = querySet(sources);
  console.error(`Running ${queries.length} queries directly ...`);
  lines.push(...summarize("raw search() latency, limit 50:", rawLatency(queries)));

  if (!flag("--skip-route")) {
    console.error(`Running ${queries.length} queries through POST /api/search ...`);
    lines.push(
      ...summarize(
        "POST /api/search latency (client-measured round trip on localhost, next start):",
        await routeLatency(queries)
      )
    );
  }

  const text = lines.join("\n");
  fs.writeFileSync(path.join(OUT_DIR, "bench-report.txt"), text + "\n");
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
