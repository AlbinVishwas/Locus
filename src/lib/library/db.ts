import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { isLibraryEnabled } from "./config";

/**
 * The app's read-only connection to the library index on the external
 * drive. Never throws for a drive that's missing: every caller gets a
 * status it can show ("Library drive not connected") instead.
 *
 * "Connected" means the drive's marker file (written by the indexer's
 * volume check, storage/guard.ts) is there, on the same device as last
 * time. An unplugged drive fails that; so does an empty /Volumes/<name>
 * folder left behind on the internal disk. The connection is opened
 * read-only -- the app never writes the library index.
 */

export type LibraryConnection =
  | { status: "disabled" }
  | { status: "unconfigured" }
  | { status: "disconnected" }
  | { status: "empty" }
  | { status: "ok"; db: Database.Database };

let cached: { file: string; ino: number; markerDev: number; db: Database.Database } | null = null;

function dataDir(): string | null {
  const raw = process.env.LOCUS_DATA_DIR?.trim();
  // turbopackIgnore: a runtime path, outside the project -- never traced into a build.
  return raw ? path.resolve(/*turbopackIgnore: true*/ raw) : null;
}

function closeCached(): void {
  try {
    cached?.db.close();
  } catch {
    // the drive may already be gone
  }
  cached = null;
}

export function getLibraryDb(): LibraryConnection {
  if (!isLibraryEnabled()) return { status: "disabled" };
  const dir = dataDir();
  if (!dir) return { status: "unconfigured" };

  let markerDev: number;
  try {
    markerDev = fs.statSync(/*turbopackIgnore: true*/ path.join(dir, ".locus-data-dir")).dev;
  } catch {
    closeCached();
    return { status: "disconnected" };
  }
  const file = path.join(dir, "library", "library.db");
  let ino: number;
  try {
    ino = fs.statSync(/*turbopackIgnore: true*/ file).ino;
  } catch {
    closeCached();
    return { status: "empty" };
  }
  if (cached && cached.file === file && cached.ino === ino && cached.markerDev === markerDev) {
    return { status: "ok", db: cached.db };
  }
  closeCached();
  try {
    const db = new Database(/*turbopackIgnore: true*/ file, { readonly: true, fileMustExist: true });
    // The indexer may be mid-write; wait briefly rather than fail a search.
    db.pragma("busy_timeout = 2000");
    cached = { file, ino, markerDev, db };
    return { status: "ok", db };
  } catch (err) {
    console.error("[library] couldn't open the library index", { error: err instanceof Error ? err.message : err });
    return { status: "disconnected" };
  }
}

/**
 * For a query that failed: if the drive went away underneath it, report
 * "disconnected" (and drop the dead connection) rather than an error.
 */
export function libraryErrorStatus(err: unknown): "disconnected" | null {
  const code = String((err as { code?: unknown })?.code ?? "");
  const gone = code.startsWith("SQLITE_IOERR") || code === "SQLITE_CANTOPEN" || code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT";
  const markerGone = (() => {
    const dir = dataDir();
    if (!dir) return true;
    try {
      fs.statSync(/*turbopackIgnore: true*/ path.join(dir, ".locus-data-dir"));
      return false;
    } catch {
      return true;
    }
  })();
  if (gone || markerGone) {
    closeCached();
    return "disconnected";
  }
  return null;
}

/** Test-only. */
export function _resetLibraryDbForTests(): void {
  closeCached();
}
