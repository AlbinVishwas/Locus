/**
 * npm run library:worker
 *
 * The indexer as a long-running service, driven by the Sources page: it reads
 * the sources registry (LOCUS_DATA_DIR/library/sources.db) every couple of
 * seconds and acts on it -- a new source is scanned at once; Pause, Resume,
 * Rescan and Remove take effect within seconds; every source is rescanned
 * each LIBRARY_RESCAN_MINUTES. It is the only writer of the library index
 * (the app only reads it), shares the one-writer lock with `npm run
 * index:library`, and keeps to the same limits: at most LOCUS_LIBRARY_MAX_GB
 * (100) and always LOCUS_MIN_FREE_GB (20) free, pausing -- never deleting --
 * at either. Ctrl+C stops it cleanly; start it again any time.
 *
 * `npm run share` starts it for you when the library and an admin passcode
 * are both configured.
 *
 * Run as `TSX_DISABLE_CACHE=1 node --import tsx` (see package.json), like
 * index:library, so tsx's own cache and pipe don't land in $TMPDIR.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { loadLibraryConfig } from "../src/lib/library/config";
import { RotatingLog } from "../src/lib/library/logs";
import { LibraryIndexer } from "../src/lib/library/pipeline";
import { formatBytes, MemorySampler, progressLine } from "../src/lib/library/progress";
import { acquireLock, prepareProcessForLibraryRun } from "../src/lib/library/run";
import { openRegistry } from "../src/lib/library/sources/registry";
import { DataDirGuard, StorageRefusedError } from "../src/lib/library/storage/guard";
import { createRegistryControl, syncEnvSources } from "../src/lib/library/worker";
import type { IndexerEvent } from "../src/lib/library/pipeline";
import { logActivity } from "../src/lib/records/activity";
import { getRecordsDb } from "../src/lib/records/db";
import { usersEnabled } from "../src/lib/users/mode";

function fail(message: string): never {
  console.error(`[worker] ${message}`);
  process.exit(1);
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const config = loadLibraryConfig();
  const pollArg = process.argv.indexOf("--poll");
  const pollMs = pollArg >= 0 ? Number(process.argv[pollArg + 1]) : 2000;

  const guard = new DataDirGuard(config.dataDir, { allowExfat: config.allowExfat, minFreeBytes: config.minFreeBytes, capBytes: config.maxBytes });
  try {
    await guard.init();
  } catch (err) {
    if (err instanceof StorageRefusedError) fail(err.message);
    throw err;
  }
  for (const w of guard.warnings) console.error(`[worker] Warning: ${w}`);
  const paths = guard.paths;
  prepareProcessForLibraryRun(paths);

  let release: () => void;
  try {
    release = acquireLock(paths.lock);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  try {
    os.setPriority(10);
  } catch {
    // not fatal
  }
  const caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  caffeinate.on("error", () => {});

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runLog = new RotatingLog(path.join(paths.logs, `worker-${stamp}.log`));
  const failureLog = new RotatingLog(path.join(paths.logs, "failures.jsonl"));
  const log = (line: string) => {
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    console.log(`[worker] ${line}`);
    runLog.write(`${new Date().toISOString()} ${line}`);
  };

  const registry = openRegistry(paths.sources);
  syncEnvSources(registry, config);
  const control = createRegistryControl(registry, config);
  log(`Library data: ${paths.root} (${guard.info?.volumeName ?? "?"}, ${guard.info?.fsType}); limit ${formatBytes(config.maxBytes)}, keeping ${formatBytes(config.minFreeBytes)} free.`);

  // The administrator's activity log (users mode only): storage pauses and sources in trouble.
  const recordEvent = usersEnabled()
    ? (e: IndexerEvent) => {
        try {
          logActivity(getRecordsDb(), { kind: e.kind, scope: e.source ? `source:${e.source}` : null, status: e.kind === "indexer_resumed" ? "ok" : "error", message: e.message });
        } catch (err) {
          log(`Could not write to the activity log: ${err instanceof Error ? err.message : err}`);
        }
      }
    : undefined;
  const indexer = new LibraryIndexer({ config, guard, sources: [], log, onFailure: (e) => failureLog.write(JSON.stringify(e)), onEvent: recordEvent });
  const memory = new MemorySampler();
  memory.start(5000);
  let lastPrinted = 0;
  const ticker = setInterval(() => {
    const line = progressLine(indexer.progress, Date.now(), memory.peak).text;
    if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K[worker] ${line}`);
    else if (Date.now() - lastPrinted > 30_000) {
      console.log(`[worker] ${line}`);
      lastPrinted = Date.now();
    }
  }, 2000);

  let interrupts = 0;
  const onSignal = () => {
    if (++interrupts === 1) {
      log("Stopping: finishing what's in hand. Start the worker again to continue. (Ctrl+C again to quit now.)");
      indexer.stop();
    } else process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    log("Watching the sources registry. Add, pause, resume, rescan and remove sources from the Sources page.");
    await indexer.serve(control, { pollMs });
  } finally {
    clearInterval(ticker);
    memory.stop();
    await control.close();
    registry.close();
    caffeinate.kill();
    release();
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    log(`Stopped. Peak memory ${formatBytes(memory.peak.peakTotal)}.`);
  }
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
