import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { SourceFileError, StillChangingError, type OpenedFile } from "./types";

/**
 * Opening a PDF that already sits on a local filesystem (a folder source,
 * or a database row's file_path): in place, read-only, never copied.
 *
 * Read-only by construction: the only open() here is O_RDONLY, for the
 * header check and the streaming hash; poppler and tesseract only read too.
 */

/** macOS st_flags bit for a file whose content lives only in the cloud (an online-only synced file). */
const SF_DATALESS = 0x40000000;

/**
 * True if the file is an online-only placeholder. Reading one would make the
 * sync client download it -- to the internal disk -- so it's skipped. Cheap
 * pre-filter first (no blocks allocated for a non-empty file), then the real
 * flag, from stat(1), only for those candidates.
 */
export async function isDataless(file: string, stat: { size: number; blocks: number }): Promise<boolean> {
  if (!(stat.size > 0 && stat.blocks === 0) || process.platform !== "darwin") return false;
  return new Promise((resolve) => {
    execFile("stat", ["-f", "%Xf", file], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve((parseInt(stdout.trim(), 16) & SF_DATALESS) !== 0);
    });
  });
}

function failureKindFor(err: unknown): "permission-denied" | "vanished" | "path-too-long" | "unreadable" {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "permission-denied";
  if (code === "ENOENT" || code === "ENOTDIR") return "vanished";
  if (code === "ENAMETOOLONG") return "path-too-long";
  return "unreadable";
}

/** A PDF's header must appear in its first 1024 bytes (the spec allows leading junk). */
export function hasPdfHeader(firstBytes: Buffer): boolean {
  return firstBytes.subarray(0, 1024).includes("%PDF-");
}

export async function openLocalPdf(
  file: string,
  options: { maxFileBytes: number; settleMs: number; signal?: AbortSignal; now?: () => number }
): Promise<OpenedFile> {
  const now = options.now ?? Date.now;
  let before: fs.Stats;
  try {
    before = await fs.promises.stat(file);
  } catch (err) {
    throw new SourceFileError(failureKindFor(err), err instanceof Error ? err.message : String(err));
  }
  if (before.size > options.maxFileBytes) {
    throw new SourceFileError("too-large", `skipped: too large (${before.size} bytes, limit ${options.maxFileBytes})`);
  }
  // settleMs 0 means "don't wait" -- including for an mtime a hair ahead of
  // Date.now(), which filesystem timestamp granularity can produce.
  if (options.settleMs > 0 && now() - before.mtimeMs < options.settleMs) {
    throw new StillChangingError("modified moments ago; still being written?");
  }
  if (await isDataless(file, before)) {
    throw new SourceFileError("not-downloaded", "online-only file (not downloaded); reading it would download it to the internal disk");
  }

  const hash = createHash("sha256");
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY);
  } catch (err) {
    throw new SourceFileError(failureKindFor(err), err instanceof Error ? err.message : String(err));
  }
  let first: Buffer | null = null;
  try {
    // Streamed in 1 MB reads: memory doesn't grow with the file.
    for await (const chunk of handle.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false })) {
      if (options.signal?.aborted) throw new Error("aborted");
      const buf = chunk as Buffer;
      if (first === null) first = Buffer.from(buf.subarray(0, 1024));
      hash.update(buf);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "aborted") throw err;
    throw new SourceFileError(failureKindFor(err), err instanceof Error ? err.message : String(err));
  } finally {
    await handle.close();
  }
  if (!first || !hasPdfHeader(first)) {
    throw new SourceFileError("not-a-pdf", "skipped: not a PDF (no %PDF- header)");
  }

  let after: fs.Stats;
  try {
    after = await fs.promises.stat(file);
  } catch (err) {
    throw new SourceFileError(failureKindFor(err), err instanceof Error ? err.message : String(err));
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new StillChangingError("changed while being read; still being written?");
  }

  return {
    path: file,
    sha256: hash.digest("hex"),
    sizeBytes: after.size,
    modifiedAt: new Date(after.mtimeMs).toISOString(),
    cleanup: async () => {},
  };
}
