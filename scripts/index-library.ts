/**
 * npm run index:library [-- --watch] [--retry-failed] [--status] [--sample N] [--seed S] [--concurrency N]
 *
 * Indexes the document library (LOCUS_LIBRARY_DIR and/or LIBRARY_DB_URL +
 * LIBRARY_DB_QUERY) into the library index on the external drive at
 * LOCUS_DATA_DIR. Refuses to start if LOCUS_DATA_DIR is unset, on the Mac's
 * internal disk, on a network drive, or on FAT32/exFAT (see
 * src/lib/library/storage/volume.ts). Keeps the Mac awake (caffeinate),
 * runs at lowered priority, prints progress, and can be stopped with
 * Ctrl+C and rerun at any time: it picks up where it left off.
 *
 * package.json runs this as `TSX_DISABLE_CACHE=1 node --import tsx ...`
 * rather than through the tsx CLI: the CLI writes a compile cache and an IPC
 * pipe into $TMPDIR -- the internal disk -- before this file even starts.
 *
 * See docs/library.md.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { loadEnvConfig } from "@next/env";
import { loadLibraryConfig, libraryPaths } from "../src/lib/library/config";
import { RotatingLog } from "../src/lib/library/logs";
import { LibraryIndexer } from "../src/lib/library/pipeline";
import { formatBytes, formatDuration, MemorySampler, progressLine } from "../src/lib/library/progress";
import { acquireLock, configuredSources, prepareProcessForLibraryRun } from "../src/lib/library/run";
import { DataDirGuard, StorageRefusedError } from "../src/lib/library/storage/guard";
import { checkDataDir } from "../src/lib/library/storage/volume";
import { libraryCounts } from "../src/lib/library/store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function fail(message: string): never {
  console.error(`[library] ${message}`);
  process.exit(1);
}

async function status(dataDir: string | null): Promise<void> {
  const verdict = await checkDataDir(dataDir, { allowExfat: true });
  if (!verdict.ok) fail(verdict.message);
  const paths = libraryPaths(dataDir!);
  if (!fs.existsSync(paths.db)) {
    console.log("[library] Nothing indexed yet.");
    return;
  }
  const db = new Database(paths.db, { readonly: true, fileMustExist: true });
  const c = libraryCounts(db);
  db.close();
  console.log(JSON.stringify(c, null, 2));
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const config = loadLibraryConfig();
  if (has("--status")) return status(config.dataDir);
  if (arg("--sample")) config.sample = Number(arg("--sample"));
  if (arg("--seed")) config.sampleSeed = Number(arg("--seed"));
  if (arg("--concurrency")) config.concurrency = Number(arg("--concurrency"));

  const guard = new DataDirGuard(config.dataDir, { allowExfat: config.allowExfat, minFreeBytes: config.minFreeBytes });
  try {
    await guard.init();
  } catch (err) {
    if (err instanceof StorageRefusedError) fail(err.message);
    throw err;
  }
  for (const w of guard.warnings) console.error(`[library] Warning: ${w}`);
  const sources = configuredSources(config);
  if (sources.length === 0) {
    fail("No library source configured. Set LOCUS_LIBRARY_DIR (a folder of PDFs), or LIBRARY_DB_URL and LIBRARY_DB_QUERY.");
  }

  const paths = guard.paths;
  prepareProcessForLibraryRun(paths);
  let release: () => void;
  try {
    release = acquireLock(paths.lock);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // Lower priority for this process and every tool it starts (they inherit it).
  try {
    os.setPriority(10);
  } catch {
    // not fatal
  }
  const caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runLog = new RotatingLog(path.join(paths.logs, `run-${stamp}.log`));
  const failureLog = new RotatingLog(path.join(paths.logs, "failures.jsonl"));
  const log = (line: string) => {
    const text = `[library] ${line}`;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    console.log(text);
    runLog.write(`${new Date().toISOString()} ${line}`);
  };

  log(`Library drive: ${guard.info?.volumeName ?? "?"} (${guard.info?.mountPoint}, ${guard.info?.fsType}); data in ${paths.root}`);
  log(`Sources: ${sources.map((s) => s.label).join("; ")}`);
  log(
    `OCR ${config.ocrPages === "auto" ? "flagged pages only" : "every page"} (${config.ocrLang} @ ${config.ocrDpi} DPI), ` +
      `${config.concurrency} tool processes, ${config.filesInFlight} files at a time, files over ${formatBytes(config.maxFileBytes)} skipped`
  );

  const indexer = new LibraryIndexer({
    config,
    guard,
    sources,
    log,
    retryFailed: has("--retry-failed"),
    onFailure: (e) => failureLog.write(JSON.stringify(e)),
  });

  const memory = new MemorySampler();
  memory.start(5000);
  let lastPrinted = 0;
  const ticker = setInterval(() => {
    const line = progressLine(indexer.progress, Date.now(), memory.peak).text;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\x1b[2K[library] ${line}`);
    } else if (Date.now() - lastPrinted > 10_000) {
      console.log(`[library] ${line}`);
      lastPrinted = Date.now();
    }
    if (Date.now() - lastPrinted > 60_000 || !process.stdout.isTTY) runLog.write(`${new Date().toISOString()} ${line}`);
  }, 2000);

  let interrupts = 0;
  const onSignal = () => {
    interrupts++;
    if (interrupts === 1) {
      log("Stopping: finishing what's in hand. Rerun to continue where this left off. (Ctrl+C again to quit now.)");
      indexer.stop();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const started = Date.now();
  try {
    const p = await indexer.run({ watch: has("--watch") || config.watch });
    clearInterval(ticker);
    memory.stop();
    await memory.sample();
    const seconds = (Date.now() - started) / 1000;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    const db = new Database(paths.db, { readonly: true });
    const counts = libraryCounts(db);
    db.close();
    log(
      `${p.state === "done" ? "Finished" : "Stopped"} in ${formatDuration(seconds)}: ${p.filesIndexed} indexed, ${p.filesUnchanged} unchanged, ` +
        `${p.filesRenamed} renamed, ${p.filesDeleted} removed, ${p.filesFailed} failed; ${p.pagesDone} pages ` +
        `(${(p.pagesDone / Math.max(1, seconds)).toFixed(1)} pages/s), OCR ${p.ocrRun} run / ${p.ocrCached} cached.`
    );
    log(
      `Library now: ${counts.ready} documents ready, ${counts.pagesIndexed} pages, ${counts.jobsPending} still queued, ` +
        `${counts.failures} files not indexed ${JSON.stringify(counts.failuresByKind)} (details: ${path.join(paths.logs, "failures.jsonl")}).`
    );
    log(`Peak memory: ${formatBytes(memory.peak.peakTotal)} total (indexer ${formatBytes(memory.peak.peakSelf)} + its tool processes), ${memory.peak.samples} samples.`);
  } finally {
    clearInterval(ticker);
    memory.stop();
    caffeinate.kill();
    release();
    await Promise.all(sources.map((s) => s.close().catch(() => {})));
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
