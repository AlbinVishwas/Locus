/**
 * npm run bench:upload -- <pdf folder> <work dir> [--parallel N] [--label name] [--json out.json]
 *
 * Runs the real upload pipeline (indexUpload) over every PDF in a folder, in a
 * work directory of its own (uploads, index, OCR cache, app data), and reports
 * where the time went per file and in total: hashing/storing, text extraction,
 * indexing, OCR (wall and summed), and when each file became searchable.
 *
 * It never touches the app's own data: every path is set from <work dir>
 * before anything else is loaded. The OCR settings come from the usual
 * environment (OCR_PAGES, OCR_LANG, OCR_CONCURRENCY, ...), so the same script
 * measures the old and the new setting.
 *
 * Upload over the network is not part of this: it is the file size over the
 * connection, reported as bytes.
 */
import fs from "node:fs";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const [folder, workDirArg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  if (!folder || !workDirArg) {
    console.error("usage: bench-upload <pdf folder> <work dir> [--parallel N] [--label name] [--json out.json]");
    process.exit(2);
  }
  const workDir = path.resolve(workDirArg);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  process.env.UPLOADS_DIR = path.join(workDir, "uploads");
  process.env.LOCUS_APP_DIR = path.join(workDir, "app");
  process.env.SEARCH_INDEX_PATH = path.join(workDir, "index", "search.db");
  process.env.OCR_CACHE_PATH = path.join(workDir, "index", "ocr-cache.db");

  const parallel = Number(arg("parallel") ?? 1);
  const label = arg("label") ?? "run";
  const jsonOut = arg("json");

  const { indexUpload } = await import("../src/lib/uploads/pipeline");
  type Timings = import("../src/lib/uploads/pipeline").UploadTimings;
  const { loadUploadConfig } = await import("./indexer/config");
  const config = loadUploadConfig();

  const files = fs
    .readdirSync(folder)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();
  const conversationId = "bench-session";
  const started = Date.now();

  interface Row {
    file: string;
    bytes: number;
    searchableAt: number; // ms from the start of the whole run
    readyAt: number;
    timings: Timings | null;
    failed: string | null;
  }
  const rows: Row[] = [];

  // "searchable": a slot frees up as soon as a file's text is searchable and its OCR carries on in the
  // background (how the folder upload works now); "ready": a slot is held until the file is fully done
  // (how it worked before).
  const release = arg("release") ?? "searchable";
  const finishing: Promise<void>[] = [];

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      const bytes = fs.readFileSync(path.join(folder, file));
      const row: Row = { file, bytes: bytes.length, searchableAt: 0, readyAt: 0, timings: null, failed: null };
      const fileStart = Date.now();
      let freeSlot: () => void = () => {};
      const slot = new Promise<void>((resolve) => (freeSlot = resolve));
      const done = indexUpload({
        conversationId,
        originalFilename: file,
        bytes,
        onStage: (e) => {
          if (e.stage === "failed") row.failed = e.message;
          if (e.stage === "failed" || e.stage === "ready" || (release === "searchable" && e.stage === "searchable")) freeSlot();
        },
        onTimings: (t) => {
          row.timings = t;
          row.searchableAt = fileStart - started + t.searchableAtMs;
        },
      }).then(() => {
        row.readyAt = Date.now() - started;
        rows.push(row);
        freeSlot();
      });
      finishing.push(done);
      await slot;
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  await Promise.all(finishing);
  const totalMs = Date.now() - started;
  rows.sort((a, b) => a.file.localeCompare(b.file));

  const s = (ms: number) => (ms / 1000).toFixed(1).padStart(6);
  console.log(`\n== ${label}: ${files.length} PDFs, ${parallel} at a time (slot freed when ${release}), OCR ${config.ocrPages}/${config.ocrLang}${config.ocrLangFallback ? "+" + config.ocrLangFallback + " where Hindi shows" : ""}/${config.ocrDpi} dpi, OCR concurrency ${config.concurrency} ==`);
  console.log("file".padEnd(34) + "  pages  ocr   hash+store extract  insert  ocr-wall ocr-render(sum) ocr-tess(sum) searchable  ready");
  const sum = { pages: 0, ocr: 0, hash: 0, extract: 0, insert: 0, ocrWall: 0, render: 0, tess: 0, bytes: 0, run: 0, cached: 0 };
  const reasons: Record<string, number> = {};
  for (const r of rows) {
    const t = r.timings;
    if (!t) {
      console.log(`${r.file.slice(0, 34).padEnd(34)}  FAILED: ${r.failed}`);
      continue;
    }
    const ocr = Object.values(t.ocrPagesByReason).reduce((a, b) => a + b, 0);
    sum.pages += t.pages;
    sum.ocr += ocr;
    sum.hash += t.hashStoreMs;
    sum.extract += t.extractMs;
    sum.insert += t.insertMs;
    sum.ocrWall += t.ocrWallMs;
    sum.render += t.ocrRenderCpuMs;
    sum.tess += t.ocrTesseractCpuMs;
    sum.bytes += r.bytes;
    sum.run += t.ocrPagesRun;
    sum.cached += t.ocrPagesCached;
    for (const [k, v] of Object.entries(t.ocrPagesByReason)) reasons[k] = (reasons[k] ?? 0) + v;
    console.log(
      `${r.file.slice(0, 34).padEnd(34)}  ${String(t.pages).padStart(5)} ${String(ocr).padStart(4)}  ${s(t.hashStoreMs)}    ${s(t.extractMs)} ${s(t.insertMs)}  ${s(t.ocrWallMs)}   ${s(t.ocrRenderCpuMs)}        ${s(t.ocrTesseractCpuMs)}      ${s(r.searchableAt)}  ${s(r.readyAt)}`
    );
  }
  const firstSearchable = Math.min(...rows.map((r) => r.searchableAt));
  const allSearchable = Math.max(...rows.map((r) => r.searchableAt));
  console.log(
    `TOTAL                               ${String(sum.pages).padStart(5)} ${String(sum.ocr).padStart(4)}  ${s(sum.hash)}    ${s(sum.extract)} ${s(sum.insert)}  ${s(sum.ocrWall)}   ${s(sum.render)}        ${s(sum.tess)}`
  );
  console.log(`pages OCR'd by reason: ${JSON.stringify(reasons)}; OCR run ${sum.run}, from cache ${sum.cached}`);
  console.log(`bytes ${(sum.bytes / 1e6).toFixed(1)} MB; first file searchable after ${s(firstSearchable).trim()} s; all files' text searchable after ${s(allSearchable).trim()} s; all done after ${s(totalMs).trim()} s`);

  if (jsonOut) {
    fs.writeFileSync(
      jsonOut,
      JSON.stringify({ label, files: files.length, parallel, config: { ocrPages: config.ocrPages, ocrLang: config.ocrLang, ocrDpi: config.ocrDpi, concurrency: config.concurrency }, totalMs, firstSearchableMs: firstSearchable, allSearchableMs: allSearchable, sum, reasons, rows }, null, 2)
    );
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
