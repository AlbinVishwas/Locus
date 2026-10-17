import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { settingsKey, type IndexerConfig } from "./config";
import { createLimiter } from "./exec";
import { extractDocument, type ExtractContext } from "./extract";
import { OcrCache } from "./ocrCache";
import { listPdfs, sha256File } from "./pdf";
import {
  deleteDocument,
  openIndex,
  renameDocument,
  replaceDocument,
  storedDocuments,
} from "./store";

export interface RunSummary {
  added: string[];
  updated: string[];
  renamed: Array<{ from: string; to: string }>;
  removed: string[];
  unchanged: string[];
  failedDocuments: string[];
  ocrRun: number;
  ocrCached: number;
  seconds: number;
}

/**
 * One indexing run over config.tendersDir.
 *
 * Incremental: each PDF is identified by the SHA-256 of its bytes.
 *   - same name, same hash          -> skipped (already indexed)
 *   - same name, different hash     -> re-indexed (the file changed)
 *   - new name, hash of a missing file -> renamed in place (no re-extraction)
 *   - new name, new hash            -> indexed
 *   - indexed but no longer on disk -> removed from the index
 * A document is also redone if the extraction settings it was built with
 * changed (OCR language, OCR_PAGES, thresholds...), or if it failed to open
 * last time.
 *
 * With `force`, the index is rebuilt from scratch into a temporary file and
 * swapped in at the end, so the app keeps serving the old index meanwhile.
 * The OCR cache makes a forced rebuild cheap.
 */
export async function runIndexer(
  config: IndexerConfig,
  options: { force?: boolean; log?: (message: string) => void } = {}
): Promise<RunSummary> {
  const log = options.log ?? ((m: string) => console.error(m));
  const started = Date.now();
  const target = options.force ? `${config.indexPath}.building` : config.indexPath;
  if (options.force) fs.rmSync(target, { force: true });

  const db = openIndex(target);
  const ocrCache = new OcrCache(config.ocrCachePath);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tender-index-"));
  const summary: RunSummary = {
    added: [],
    updated: [],
    renamed: [],
    removed: [],
    unchanged: [],
    failedDocuments: [],
    ocrRun: 0,
    ocrCached: 0,
    seconds: 0,
  };

  try {
    const filenames = await listPdfs(config.tendersDir);
    log(`Hashing ${filenames.length} PDFs in ${config.tendersDir}`);
    const onDisk = new Map<string, { sha256: string; size: number }>();
    for (const name of filenames) {
      const file = path.join(config.tendersDir, name);
      onDisk.set(name, { sha256: await sha256File(file), size: fs.statSync(file).size });
    }

    const settings = settingsKey(config);
    const stored = storedDocuments(db);
    const storedByName = new Map(stored.map((d) => [d.filename, d]));

    // Renames: a file that vanished whose exact bytes reappear under a new name.
    const vanished = stored.filter((d) => !onDisk.has(d.filename));
    for (const [name, { sha256 }] of onDisk) {
      if (storedByName.has(name)) continue;
      const match = vanished.find((d) => d.sha256 === sha256 && d.settings === settings && !d.error);
      if (match) {
        renameDocument(db, match.id, name);
        summary.renamed.push({ from: match.filename, to: name });
        vanished.splice(vanished.indexOf(match), 1);
        storedByName.set(name, { ...match, filename: name });
      }
    }

    for (const doc of vanished) {
      db.transaction(() => deleteDocument(db, doc.id))();
      summary.removed.push(doc.filename);
    }

    const todo: Array<{ name: string; sha256: string; size: number; isNew: boolean }> = [];
    for (const [name, { sha256, size }] of onDisk) {
      const existing = storedByName.get(name);
      if (
        existing &&
        existing.sha256 === sha256 &&
        existing.settings === settings &&
        !existing.error
      ) {
        if (!summary.renamed.some((r) => r.to === name)) summary.unchanged.push(name);
        continue;
      }
      todo.push({ name, sha256, size, isNew: !existing });
    }

    const ctx: ExtractContext = {
      config,
      limit: createLimiter(config.concurrency),
      ocrCache,
      tempDir,
      log,
      stats: { ocrRun: 0, ocrCached: 0 },
    };

    log(
      `${todo.length} to index, ${summary.unchanged.length} unchanged, ` +
        `${summary.renamed.length} renamed, ${summary.removed.length} removed ` +
        `(concurrency ${config.concurrency}, OCR ${config.ocrPages} pages, ${config.ocrLang} @ ${config.ocrDpi} DPI)`
    );

    // Documents are extracted concurrently (the limiter caps total work) and
    // each is written in its own transaction as soon as it's done.
    await Promise.all(
      todo.map(async (item) => {
        const file = path.join(config.tendersDir, item.name);
        const doc = await extractDocument(file, item.sha256, item.size, ctx);
        replaceDocument(db, doc);
        (item.isNew ? summary.added : summary.updated).push(item.name);
        if (doc.error) summary.failedDocuments.push(item.name);
        log(`  ✓ ${item.name} (${doc.pageCount} pages)`);
      })
    );

    summary.ocrRun = ctx.stats.ocrRun;
    summary.ocrCached = ctx.stats.ocrCached;
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_run', ?)").run(
      new Date().toISOString()
    );
  } finally {
    db.close();
    ocrCache.close();
    await fsp.rm(tempDir, { recursive: true, force: true });
  }

  if (options.force) fs.renameSync(target, config.indexPath);
  summary.seconds = (Date.now() - started) / 1000;
  return summary;
}
