/**
 * npm run bench:server -- [--files N] [--seed S] [--keep] [--json out.json]
 *
 * Measures indexing a storage server and searching it, on a generated set of PDFs (nothing from a client): time to the
 * first searchable page and file, time to a full index, index size against PDF size, and search latency.
 *
 * Two runs on the same set, one after the other, each in a data folder of its own:
 *   before  FolderSource + OCR "auto": how a library folder was indexed before the storage-server work
 *   after   ConnectorSource over a folder connector + OCR "smart": the new default
 * plus a text-only set, which gives the largest index-per-PDF-byte ratio (the default behind the disk estimate).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { libraryPaths, loadLibraryConfig, type LibraryConfig } from "../src/lib/library/config";
import { LibraryIndexer } from "../src/lib/library/pipeline";
import { librarySearch } from "../src/lib/library/query";
import { acquireLock, prepareProcessForLibraryRun } from "../src/lib/library/run";
import { FolderSource } from "../src/lib/library/sources/folder";
import type { LibrarySource } from "../src/lib/library/sources/types";
import { DataDirGuard } from "../src/lib/library/storage/guard";
import { ConnectorSource } from "../src/lib/server/connectorSource";
import { FolderConnector } from "../src/lib/server/folderConnector";
import { generateTestPdfs, type GeneratedFile } from "./gen-test-pdfs";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const q = (xs: number[], f: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(f * xs.length))];

interface Result {
  label: string;
  files: number;
  pdfBytes: number;
  firstPageMs: number;
  firstFileMs: number;
  fullMs: number;
  indexBytes: number;
  ratio: number;
  pages: number;
  kbPerPage: number;
  ocrPages: number;
  failed: number;
  searchP50: number;
  searchP95: number;
  hitsRight: number;
  hitsTotal: number;
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(f);
    else if (e.isFile()) total += fs.statSync(f).size;
  }
  return total;
}

async function runOnce(label: string, serverDir: string, manifest: GeneratedFile[], makeSource: (config: LibraryConfig) => LibrarySource, ocrPages: "auto" | "smart"): Promise<Result> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-bench-"));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const config: LibraryConfig = { ...loadLibraryConfig({ LIBRARY_OCR_PAGES: ocrPages }), dataDir, settleSeconds: 0, minFreeBytes: 0 };
  const guard = new DataDirGuard(dataDir, { allowExfat: false, minFreeBytes: 0, capBytes: config.maxBytes, locationFile: null });
  await guard.init();
  prepareProcessForLibraryRun(guard.paths);
  const release = acquireLock(guard.paths.lock);
  const indexer = new LibraryIndexer({ config, guard, sources: [makeSource(config)], log: () => {} });
  const started = performance.now();
  let firstPage = 0;
  let firstFile = 0;
  const dbFile = libraryPaths(dataDir).db;
  const poll = setInterval(() => {
    try {
      const db = new Database(dbFile, { readonly: true });
      if (!firstPage && Number(db.prepare("SELECT count(*) FROM texts").pluck().get()) > 0) firstPage = performance.now() - started;
      if (!firstFile && Number(db.prepare("SELECT count(*) FROM documents WHERE status = 'ready'").pluck().get()) > 0) firstFile = performance.now() - started;
      db.close();
    } catch {
      // not created yet
    }
  }, 25);
  const progress = await indexer.run();
  const fullMs = performance.now() - started;
  clearInterval(poll);
  release();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const indexBytes = dirBytes(libraryPaths(dataDir).root) - dirBytes(libraryPaths(dataDir).tmp) - dirBytes(libraryPaths(dataDir).logs);
  const pages = (() => {
    const d = new Database(dbFile, { readonly: true });
    try {
      return Number(d.prepare("SELECT coalesce(sum(pages_done), 0) FROM documents").pluck().get());
    } finally {
      d.close();
    }
  })();
  const pdfBytes = manifest.filter((f) => f.kind !== "corrupt").reduce((s, f) => s + f.bytes, 0);

  // Search: every planted marker (the right file and page must come back), plus words that are everywhere and words that aren't.
  const db = new Database(dbFile, { readonly: true });
  const lat: number[] = [];
  let right = 0;
  let total = 0;
  const planted = manifest.filter((f) => f.marker);
  for (let round = 0; round < 3; round++) {
    for (const f of planted) {
      const t = performance.now();
      const out = librarySearch(db, f.marker!, { mode: "exact" });
      lat.push(performance.now() - t);
      if (round === 0) {
        total++;
        if (out.status === "ok" && out.result.hits.some((h) => h.displayName === f.path && h.pageNo === f.markerPage)) right++;
        else if (process.argv.includes("--verbose")) console.log(`  miss: ${f.kind} ${f.path} p${f.markerPage} marker ${f.marker}`);
      }
    }
  }
  for (const w of ["reference", "kamel", "dorvan", "zzzznotthere", "applies here"]) for (let i = 0; i < 20; i++) {
    const t = performance.now();
    librarySearch(db, w, { mode: "exact" });
    lat.push(performance.now() - t);
  }
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  return {
    label,
    files: progress.filesIndexed,
    pdfBytes,
    firstPageMs: firstPage,
    firstFileMs: firstFile,
    fullMs,
    indexBytes,
    ratio: indexBytes / pdfBytes,
    pages,
    kbPerPage: indexBytes / 1024 / Math.max(1, pages),
    ocrPages: progress.ocrRun,
    failed: progress.filesFailed,
    searchP50: q(lat, 0.5),
    searchP95: q(lat, 0.95),
    hitsRight: right,
    hitsTotal: total,
  };
}

function print(r: Result) {
  const s = (ms: number) => (ms / 1000).toFixed(1).padStart(6);
  console.log(
    `${r.label.padEnd(34)} ${String(r.files).padStart(4)} files ${(r.pdfBytes / 1e6).toFixed(1).padStart(6)} MB | first page ${s(r.firstPageMs)} s, first file ${s(r.firstFileMs)} s, full ${s(r.fullMs)} s | index ${(r.indexBytes / 1e6).toFixed(1).padStart(6)} MB = ${r.ratio.toFixed(2)}x of the PDFs, ${r.pages} pages, ${r.kbPerPage.toFixed(1)} KB/page | OCR'd ${String(r.ocrPages).padStart(4)} pages, ${r.failed} failed | search p50 ${r.searchP50.toFixed(2)} ms p95 ${r.searchP95.toFixed(2)} ms | right ${r.hitsRight}/${r.hitsTotal}`
  );
}

async function main() {
  const files = Number(arg("files") ?? 60);
  const seed = Number(arg("seed") ?? 20261028);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-bench-set-"));
  const mixedDir = path.join(root, "mixed");
  const textDir = path.join(root, "text");
  const mixed = await generateTestPdfs(mixedDir, { files, seed });
  const text = await generateTestPdfs(textDir, { files: Math.max(10, Math.round(files * 0.6)), scanned: 0, mixed: 0, seed: seed + 1 });
  console.log(`\nGenerated ${mixed.length} PDFs for the mixed set (${(mixed.reduce((s, f) => s + f.bytes, 0) / 1e6).toFixed(1)} MB: ${mixed.filter((f) => f.kind === "scanned").length} scanned, ${mixed.filter((f) => f.kind === "mixed").length} mixed, ${mixed.filter((f) => f.kind === "text").length} typed, 1 corrupt), ${os.availableParallelism()} CPU cores\n`);

  const folderSource = (dir: string) => (c: LibraryConfig) => new FolderSource(dir, { include: c.include, exclude: c.exclude, crossDevice: false, maxFileBytes: c.maxFileBytes, settleSeconds: 0 });
  const connectorSource = (dir: string) => (c: LibraryConfig) => new ConnectorSource({ id: "env-server", name: "Company server", connector: new FolderConnector(dir), maxFileBytes: c.maxFileBytes, settleSeconds: 0 });

  const results: Result[] = [];
  results.push(await runOnce("before: folder source, OCR auto", mixedDir, mixed, folderSource(mixedDir), "auto"));
  results.push(await runOnce("after:  storage server, OCR smart", mixedDir, mixed, connectorSource(mixedDir), "smart"));
  results.push(await runOnce("text-only set (ratio for estimate)", textDir, text, connectorSource(textDir), "smart"));
  for (const r of results) print(r);
  const jsonOut = arg("json");
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ cores: os.availableParallelism(), results }, null, 2));
  if (!process.argv.includes("--keep")) fs.rmSync(root, { recursive: true, force: true });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
