import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultDataDir, isLibraryEnabled } from "./config";
import { isUnderVolumes, readLocation } from "./storage/location";

/**
 * The app's read-only connection to the library index on the external
 * drive. Never throws for a drive that's missing: every caller gets a
 * status it can show ("Library drive not connected") instead.
 *
 * The library lives on this Mac's disk by default, or on an external drive.
 * "Connected" means the marker file (written by the indexer's volume check,
 * storage/guard.ts) is there, on the same device as last time. An unplugged
 * external drive fails that; so does an empty /Volumes/<name> folder left
 * behind on the internal disk. For a library that lives on the Mac's own
 * disk there is nothing to unplug, so a missing marker just means nothing has
 * been indexed yet. The connection is opened read-only -- the app never
 * writes the library index.
 */

export type LibraryConnection =
  | { status: "disabled" }
  | { status: "disconnected" }
  | { status: "empty" }
  | { status: "ok"; db: Database.Database };

let cached: { file: string; ino: number; markerDev: number; db: Database.Database } | null = null;

export function libraryDataDir(): string {
  const raw = process.env.LOCUS_DATA_DIR?.trim();
  // turbopackIgnore: a runtime path -- never traced into a build.
  return raw ? path.resolve(/*turbopackIgnore: true*/ raw) : defaultDataDir();
}

/** Whether the library lives on a drive that can go away (so a missing marker means "unplugged", not "not started"). */
function onRemovableDrive(dir: string): boolean {
  if (isUnderVolumes(dir)) return true;
  const loc = readLocation();
  return loc !== null && loc.external && path.resolve(loc.dataDir) === dir;
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
  const dir = libraryDataDir();

  let markerDev: number;
  try {
    markerDev = fs.statSync(/*turbopackIgnore: true*/ path.join(dir, ".locus-data-dir")).dev;
  } catch {
    closeCached();
    return onRemovableDrive(dir) ? { status: "disconnected" } : { status: "empty" };
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
    const dir = libraryDataDir();
    if (!onRemovableDrive(dir)) return false;
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
