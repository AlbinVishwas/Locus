import fs from "node:fs";
import path from "node:path";
import type { LibraryPaths } from "../config";

/**
 * How much disk the library is really using: the sum of `st_blocks * 512`
 * over everything under LOCUS_DATA_DIR/library (index and its WAL, OCR
 * cache, registry, logs, temp files, inventory) -- what the disk actually
 * holds, including preallocated and sparse space, not file sizes.
 *
 * Two speeds. A full walk of the (few) files is cheap but not free, so it
 * runs at most every `walkEveryMs`; between walks, `fast()` re-stats only the
 * files that change quickly (the index, its WAL, the OCR cache and its WAL)
 * and adds the difference to the last walk, which is what the check before
 * every write uses.
 */

const BLOCK = 512;

export function diskBytes(stat: fs.Stats): number {
  return stat.blocks * BLOCK;
}

/** Sum of allocated bytes under `dir` (missing = 0). Does not follow symlinks. */
export function directoryDiskBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += directoryDiskBytes(full);
      else if (e.isFile()) total += diskBytes(fs.lstatSync(full));
    } catch {
      // vanished mid-walk (a temp file being deleted)
    }
  }
  return total;
}

function fileDiskBytes(file: string): number {
  try {
    return diskBytes(fs.lstatSync(file));
  } catch {
    return 0;
  }
}

export class UsageMeter {
  private walkTotal = 0;
  private bigAtWalk = 0;
  private lastWalk = 0;
  private readonly big: string[];

  constructor(
    private readonly paths: LibraryPaths,
    private readonly walkEveryMs = 30_000,
    private readonly now: () => number = Date.now
  ) {
    this.big = [paths.db, `${paths.db}-wal`, paths.ocrCache, `${paths.ocrCache}-wal`];
  }

  private bigNow(): number {
    return this.big.reduce((sum, f) => sum + fileDiskBytes(f), 0);
  }

  /** Walks everything now. */
  refresh(): number {
    this.walkTotal = directoryDiskBytes(this.paths.root);
    this.bigAtWalk = this.bigNow();
    this.lastWalk = this.now();
    return this.walkTotal;
  }

  /** Current usage: the last walk, adjusted for how much the fast-growing files have changed since. */
  usedBytes(): number {
    if (this.lastWalk === 0 || this.now() - this.lastWalk > this.walkEveryMs) return this.refresh();
    return Math.max(0, this.walkTotal - this.bigAtWalk + this.bigNow());
  }
}
