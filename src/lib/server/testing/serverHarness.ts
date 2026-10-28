/**
 * Test-only: runs the real library indexer over a storage connector, in this process or (as a CLI) in its own
 * process so a test can SIGKILL it mid-run. The external-drive check is replaced by the library tests' fake guard.
 *
 *   tsx serverHarness.ts <serverFolder> <dataDir> [configOverridesJson]
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { libraryPaths, type LibraryConfig } from "../../library/config";
import { LibraryIndexer, type Progress } from "../../library/pipeline";
import { acquireLock, prepareProcessForLibraryRun } from "../../library/run";
import { fakeGuard, testConfig, type FakeGuard } from "../../library/testing/helpers";
import { ConnectorSource } from "../connectorSource";
import { FolderConnector } from "../folderConnector";
import type { StorageConnector } from "../types";

export const SERVER_ID = "env-server";

export interface SyncRun {
  progress: Progress;
  guard: FakeGuard;
}

/** One sync: scan the connector, index what's new or changed, sweep what's gone. */
export async function syncOnce(connector: StorageConnector, dataDir: string, o: { config?: Partial<LibraryConfig>; guard?: FakeGuard; beforeScan?: (s: AbortSignal) => Promise<void>; log?: (l: string) => void; onIndexer?: (i: LibraryIndexer) => void } = {}): Promise<SyncRun> {
  const config = testConfig({ ocrPages: "smart", ...(o.config ?? {}) });
  const guard = o.guard ?? fakeGuard(dataDir);
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  prepareProcessForLibraryRun(guard.paths);
  const release = acquireLock(guard.paths.lock);
  try {
    const source = new ConnectorSource({ id: SERVER_ID, name: "Company server", connector, maxFileBytes: config.maxFileBytes, settleSeconds: 0, beforeScan: o.beforeScan });
    const indexer = new LibraryIndexer({ config, guard, sources: [source], log: o.log ?? (() => {}), idlePollMs: 20, spaceCheckMs: 50 });
    o.onIndexer?.(indexer);
    const progress = await indexer.run();
    return { progress, guard };
  } finally {
    release();
    // Tests run many syncs in one process: don't leave TMPDIR pointing into a data folder that is about to be deleted.
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function openLibrary(dataDir: string): Database.Database {
  return new Database(libraryPaths(dataDir).db, { readonly: true });
}

export interface DocRow {
  key: string;
  status: string;
  page_count: number;
}

export function documents(dataDir: string): DocRow[] {
  const db = openLibrary(dataDir);
  try {
    return db.prepare("SELECT key, status, page_count FROM documents ORDER BY key").all() as DocRow[];
  } finally {
    db.close();
  }
}

export function failures(dataDir: string): Array<{ key: string; kind: string; message: string | null }> {
  const db = openLibrary(dataDir);
  try {
    return db.prepare("SELECT key, kind, message FROM failures ORDER BY key").all() as Array<{ key: string; kind: string; message: string | null }>;
  } finally {
    db.close();
  }
}

/** Exact-mode search over the library index for a marker word: [{key, page}]. */
export function find(dataDir: string, word: string): Array<{ key: string; page: number }> {
  const db = openLibrary(dataDir);
  try {
    const rows = db.prepare("SELECT rowid FROM texts_exact WHERE texts_exact MATCH ?").pluck().all(`"${word.toLowerCase()}"`) as number[];
    const doc = db.prepare("SELECT key FROM documents WHERE id = ?").pluck();
    const seen = new Set<string>();
    const hits: Array<{ key: string; page: number }> = [];
    for (const id of rows) {
      const docId = Math.floor(id / 2 ** 21);
      const page = Math.floor((id - docId * 2 ** 21) / 2);
      const key = doc.get(docId) as string;
      if (seen.has(`${key}#${page}`)) continue; // a page read twice (text layer and OCR) is one hit
      seen.add(`${key}#${page}`);
      hits.push({ key, page });
    }
    return hits;
  } finally {
    db.close();
  }
}

if (process.argv[1] && /serverHarness\.[tj]s$/.test(process.argv[1])) {
  (async () => {
    const [serverDir, dataDir, overrides] = process.argv.slice(2);
    const { progress } = await syncOnce(new FolderConnector(serverDir), dataDir, { config: overrides ? JSON.parse(overrides) : {}, log: (l) => console.log(l) });
    fs.writeSync(1, `DONE ${JSON.stringify({ indexed: progress.filesIndexed, unchanged: progress.filesUnchanged, deleted: progress.filesDeleted, failed: progress.filesFailed, pages: progress.pagesDone })}\n`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
