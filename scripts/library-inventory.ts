/**
 * npm run library:inventory [-- --sample 300] [--fresh]
 *
 * Scans LOCUS_LIBRARY_DIR without indexing or OCR'ing it, samples ~300
 * random PDFs, and projects what indexing the whole folder would take.
 * Writes the report (Markdown + JSON) to LOCUS_DATA_DIR/library/inventory/.
 * Safe to stop (Ctrl+C) and rerun: it continues where it stopped. --fresh
 * discards the checkpoint and starts over.
 *
 * Run as `TSX_DISABLE_CACHE=1 node --import tsx` (see package.json), for the
 * same reason as index:library: nothing on the internal disk.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { loadLibraryConfig } from "../src/lib/library/config";
import { analyzeSample, project, renderReport, scanInventory, writeAtomically } from "../src/lib/library/inventory";
import { formatDuration } from "../src/lib/library/progress";
import { prepareProcessForLibraryRun } from "../src/lib/library/run";
import { DataDirGuard, StorageRefusedError } from "../src/lib/library/storage/guard";

function fail(message: string): never {
  console.error(`[inventory] ${message}`);
  process.exit(1);
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const config = loadLibraryConfig();
  const sampleIdx = process.argv.indexOf("--sample");
  const sampleSize = sampleIdx >= 0 ? Number(process.argv[sampleIdx + 1]) : 300;
  if (!config.libraryDir) fail("Set LOCUS_LIBRARY_DIR to the folder to inventory.");

  const guard = new DataDirGuard(config.dataDir, { allowExfat: config.allowExfat, minFreeBytes: 0 });
  try {
    await guard.init();
  } catch (err) {
    if (err instanceof StorageRefusedError) fail(err.message);
    throw err;
  }
  const paths = guard.paths;
  prepareProcessForLibraryRun(paths);
  const checkpoint = path.join(paths.inventory, "checkpoint.json");
  if (process.argv.includes("--fresh")) fs.rmSync(checkpoint, { force: true });

  const controller = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    console.log("\n[inventory] Stopping after the current folder's counts are saved. Rerun to continue.");
    controller.abort();
  });

  const root = fs.realpathSync(config.libraryDir);
  console.log(`[inventory] Scanning ${root} (no indexing, no OCR)…`);
  let lastPrint = 0;
  const scan = await scanInventory(
    { root, include: config.include, exclude: config.exclude, crossDevice: config.crossDevice, maxFileBytes: config.maxFileBytes, sampleSize, seed: config.sampleSeed },
    checkpoint,
    {
      signal: controller.signal,
      onProgress: (t) => {
        if (Date.now() - lastPrint > 2000) {
          process.stdout.write(`\r\x1b[2K[inventory] ${t.files.toLocaleString("en-US")} files counted, ${t.pdfs.files.toLocaleString("en-US")} PDFs`);
          lastPrint = Date.now();
        }
      },
    }
  );
  process.stdout.write("\r\x1b[2K");
  if (!scan.complete) {
    console.log(`[inventory] Stopped after ${formatDuration(scan.thisRunSeconds)}; progress saved. Rerun to continue.`);
    return;
  }
  console.log(
    `[inventory] Scan ${scan.resumed ? "complete (resumed)" : "complete"}: ${scan.tally.files.toLocaleString("en-US")} files, ${scan.tally.pdfs.files.toLocaleString("en-US")} PDFs, ` +
      `scan time ${formatDuration(scan.scanSeconds)}.`
  );

  const tmp = fs.mkdtempSync(path.join(paths.tmp, "inventory-"));
  let analysis = null;
  let sampleSeconds: number | null = null;
  try {
    console.log(`[inventory] Sampling ${scan.tally.sample.items.length} random PDFs (page counts, which pages need OCR; ~20 OCR'd once to time it, then discarded)…`);
    const started = Date.now();
    analysis = await analyzeSample(scan.tally.sample.items, config, tmp, {
      signal: controller.signal,
      onProgress: (done, total) => process.stdout.write(`\r\x1b[2K[inventory] sampled ${done}/${total}`),
    });
    sampleSeconds = (Date.now() - started) / 1000;
    process.stdout.write("\r\x1b[2K");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (controller.signal.aborted) {
    console.log("[inventory] Stopped during sampling. Rerun to sample again (the scan is saved).");
    return;
  }

  const projection = project(scan.tally, analysis, config.concurrency);
  const generatedAt = new Date().toISOString();
  const report = renderReport({ root, dataDir: paths.inventory, generatedAt, scan, analysis, projection, sampleSeconds, config });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  writeAtomically(path.join(paths.inventory, `report-${stamp}.md`), report);
  writeAtomically(
    path.join(paths.inventory, `report-${stamp}.json`),
    JSON.stringify({ root, generatedAt, scan: { ...scan, tally: { ...scan.tally, sample: { seen: scan.tally.sample.seen, size: scan.tally.sample.items.length } } }, analysis, projection }, null, 2)
  );
  console.log(report);
  console.log(`[inventory] Report saved to ${path.join(paths.inventory, `report-${stamp}.md`)} (and .json).`);
}

main().catch((err) => fail(err instanceof Error ? (err.stack ?? err.message) : String(err)));
