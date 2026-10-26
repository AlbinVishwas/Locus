import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

/**
 * A streaming, depth-first walk of a folder tree that may be terabytes and
 * millions of files: memory stays constant whatever its size. There is no
 * file list anywhere -- each directory is read through `fs.opendir`, which
 * streams entries a few dozen at a time, and only the chain of directories
 * from the root to the current one is held open.
 *
 * Every problem is reported with a reason and the walk goes on:
 * permission denied, a path too long, a name that isn't valid Unicode, a
 * file or folder that vanishes mid-walk, a symlink (never followed, so a
 * symlink loop can't happen), a directory cycle through a firmlink or hard
 * link (caught by the device+inode of every directory on the current path),
 * another mounted device inside the tree (not crossed unless asked).
 */

export type SkipReason =
  | "permission-denied"
  | "path-too-long"
  | "too-deep"
  | "vanished"
  | "unreadable-filename"
  | "symlink"
  | "other-device"
  | "directory-cycle"
  | "too-large"
  | "not-downloaded"
  | "still-being-written"
  | "not-a-pdf"
  | "not-allowed"
  | "error";

export interface SkipRecord {
  /** Folder-relative, NFC. */
  relPath: string;
  reason: SkipReason;
  isDirectory: boolean;
  detail?: string;
}

export interface WalkFile {
  /** Folder-relative path, NFC-normalized: the stable identity of the file. */
  relPath: string;
  /** The path exactly as the filesystem spells it, for opening. */
  absPath: string;
  size: number;
  mtimeMs: number;
  /** 512-byte blocks allocated; 0 with a non-zero size suggests an online-only (dataless) file. */
  blocks: number;
  dev: number;
  ino: number;
}

export interface WalkOptions {
  include: string[];
  exclude: string[];
  crossDevice?: boolean;
  /** Stat files that aren't included (PDFs) too, so their sizes can be reported (the inventory). */
  statOthers?: boolean;
  onSkip: (skip: SkipRecord) => void;
  /** Every file that isn't included, by lower-case extension ("" for none). */
  onOther?: (ext: string, size: number | null) => void;
  /** Files and directories the exclude patterns matched (counted, not logged one by one). */
  onExcluded?: (relPath: string, isDirectory: boolean) => void;
  onDirEnter?: (relPath: string, depth: number) => void;
  /** Called once a directory and everything under it has been walked. Not called for an aborted walk. */
  onDirDone?: (relPath: string, depth: number) => void;
  /** Return true to skip a directory entirely (the inventory's resume). */
  skipDir?: (relPath: string, depth: number) => boolean;
  signal?: AbortSignal;
}

/** Deeper than this, a directory is skipped: each level holds a file descriptor open. */
export const MAX_DEPTH = 128;

interface Frame {
  dir: fs.Dir;
  rel: string;
  abs: string;
  key: string;
  depth: number;
}

function errorReason(err: unknown): SkipReason {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENAMETOOLONG") return "path-too-long";
  if (code === "ENOENT" || code === "ENOTDIR") return "vanished";
  return "error";
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function extensionOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext.startsWith(".") ? ext.slice(1) : "";
}

export async function* walk(root: string, options: WalkOptions): AsyncGenerator<WalkFile> {
  const isIncluded = picomatch(options.include, { dot: true, nocase: true });
  const isExcluded = picomatch(options.exclude, { dot: true, nocase: true });
  const crossDevice = options.crossDevice ?? false;

  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.lstat(root);
  } catch (err) {
    options.onSkip({ relPath: "", reason: errorReason(err), isDirectory: true, detail: errorDetail(err) });
    return;
  }
  const rootDev = rootStat.dev;
  const stack: Frame[] = [];
  const onPath = new Set<string>();

  const enter = async (abs: string, rel: string, stat: fs.Stats, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) {
      options.onSkip({ relPath: rel, reason: "too-deep", isDirectory: true });
      return;
    }
    const key = `${stat.dev}:${stat.ino}`;
    if (onPath.has(key)) {
      options.onSkip({ relPath: rel, reason: "directory-cycle", isDirectory: true });
      return;
    }
    if (!crossDevice && stat.dev !== rootDev) {
      options.onSkip({ relPath: rel, reason: "other-device", isDirectory: true });
      return;
    }
    if (options.skipDir?.(rel, depth)) return;
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(abs, { bufferSize: 64 });
    } catch (err) {
      options.onSkip({ relPath: rel, reason: errorReason(err), isDirectory: true, detail: errorDetail(err) });
      return;
    }
    onPath.add(key);
    stack.push({ dir, rel, abs, key, depth });
    options.onDirEnter?.(rel, depth);
  };

  try {
    await enter(root, "", rootStat, 0);
    while (stack.length > 0) {
      if (options.signal?.aborted) return;
      const frame = stack[stack.length - 1];
      let entry: fs.Dirent | null;
      try {
        entry = await frame.dir.read();
      } catch (err) {
        // The directory went away or became unreadable mid-listing: report
        // it and move on with its parent.
        options.onSkip({ relPath: frame.rel, reason: errorReason(err), isDirectory: true, detail: errorDetail(err) });
        entry = null;
      }
      if (entry === null) {
        stack.pop();
        onPath.delete(frame.key);
        await frame.dir.close().catch(() => {});
        options.onDirDone?.(frame.rel, frame.depth);
        continue;
      }

      const rawName = entry.name;
      const rel = (frame.rel ? `${frame.rel}/${rawName}` : rawName).normalize("NFC");
      const abs = path.join(frame.abs, rawName);

      if (rawName.includes("�")) {
        // Node had to replace bytes that aren't valid UTF-8 (possible on
        // exFAT/SMB/NTFS, never on APFS); the path can't be opened reliably.
        options.onSkip({ relPath: rel, reason: "unreadable-filename", isDirectory: entry.isDirectory() });
        continue;
      }
      if (entry.isSymbolicLink()) {
        options.onSkip({ relPath: rel, reason: "symlink", isDirectory: false });
        continue;
      }

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let stat: fs.Stats | null = null;
      if (!isDir && !isFile) {
        // Some filesystems don't report the entry type in the listing.
        try {
          stat = await fs.promises.lstat(abs);
        } catch (err) {
          options.onSkip({ relPath: rel, reason: errorReason(err), isDirectory: false, detail: errorDetail(err) });
          continue;
        }
        if (stat.isSymbolicLink()) {
          options.onSkip({ relPath: rel, reason: "symlink", isDirectory: false });
          continue;
        }
        isDir = stat.isDirectory();
        isFile = stat.isFile();
        if (!isDir && !isFile) continue; // sockets, devices, FIFOs
      }

      if (isExcluded(rel)) {
        options.onExcluded?.(rel, isDir);
        continue;
      }

      if (isDir) {
        try {
          stat ??= await fs.promises.lstat(abs);
        } catch (err) {
          options.onSkip({ relPath: rel, reason: errorReason(err), isDirectory: true, detail: errorDetail(err) });
          continue;
        }
        await enter(abs, rel, stat, frame.depth + 1);
        continue;
      }

      const included = isIncluded(rel);
      if (!included && !options.statOthers) {
        options.onOther?.(extensionOf(rawName), null);
        continue;
      }
      try {
        stat ??= await fs.promises.lstat(abs);
      } catch (err) {
        options.onSkip({ relPath: rel, reason: errorReason(err), isDirectory: false, detail: errorDetail(err) });
        continue;
      }
      if (!included) {
        options.onOther?.(extensionOf(rawName), stat.size);
        continue;
      }
      yield {
        relPath: rel,
        absPath: abs,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        blocks: stat.blocks,
        dev: stat.dev,
        ino: stat.ino,
      };
    }
  } finally {
    // An aborted or abandoned walk still releases every open directory.
    for (const frame of stack) await frame.dir.close().catch(() => {});
  }
}
