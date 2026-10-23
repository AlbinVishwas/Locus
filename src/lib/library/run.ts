import fs from "node:fs";
import type { LibraryConfig, LibraryPaths } from "./config";
import { DatabaseSource } from "./sources/database";
import { FolderSource } from "./sources/folder";
import type { LibrarySource } from "./sources/types";

/**
 * Process-wide setup for anything that runs library work (the indexer, the
 * inventory), shared so tests exercise exactly what the CLIs do.
 *
 * TMPDIR (and TMP/TEMP) point at library/tmp on the external drive before
 * any work starts: Node's os.tmpdir() reads it, and every external tool the
 * library starts (pdftotext, pdftoppm, tesseract) inherits it. Library code
 * never calls os.tmpdir() itself -- it uses paths.tmp -- so this is the
 * belt to that pair of braces.
 */
export function prepareProcessForLibraryRun(paths: LibraryPaths): void {
  fs.mkdirSync(paths.tmp, { recursive: true });
  process.env.TMPDIR = paths.tmp;
  process.env.TMP = paths.tmp;
  process.env.TEMP = paths.tmp;
}

/** The sources configured in the environment: a folder, a database, or both. */
export function configuredSources(config: LibraryConfig): LibrarySource[] {
  const sources: LibrarySource[] = [];
  if (config.libraryDir) {
    sources.push(
      new FolderSource(config.libraryDir, {
        include: config.include,
        exclude: config.exclude,
        crossDevice: config.crossDevice,
        maxFileBytes: config.maxFileBytes,
        settleSeconds: config.settleSeconds,
      })
    );
  }
  if (config.dbUrl || config.dbQuery) {
    if (!config.dbUrl || !config.dbQuery) {
      throw new Error("A database source needs both LIBRARY_DB_URL and LIBRARY_DB_QUERY.");
    }
    sources.push(
      new DatabaseSource(config.dbUrl, config.dbQuery, {
        batchSize: config.dbBatchSize,
        maxFileBytes: config.maxFileBytes,
        settleSeconds: config.settleSeconds,
      })
    );
  }
  return sources;
}

/**
 * One writer at a time: a lock file holding this process's pid. A lock left
 * by a process that no longer exists (a crash, a kill -9) is taken over.
 */
export function acquireLock(lockFile: string): () => void {
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      return () => {
        try {
          if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.rmSync(lockFile);
        } catch {
          // already gone (drive unplugged, say)
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const pid = Number(fs.readFileSync(lockFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) {
        throw new Error(`Another library indexer is already running (pid ${pid}). Only one may write the library index at a time.`);
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
