import fs from "node:fs/promises";
import path from "node:path";
import { uploadsDir } from "./config";

/**
 * Where uploaded files live on disk, and how much space they (plus the
 * index and OCR cache) are using.
 *
 * Content-addressed: a file is stored as `<sha256>.pdf`, named by its own
 * bytes rather than by anything the uploader called it. Two conversations
 * uploading byte-identical PDFs -- the same tender notice, say -- store it
 * once, and the original filename is kept separately in the database for
 * display, never used as or derived into a path.
 */

export function storedPathFor(sha256: string): string {
  return path.join(uploadsDir(), `${sha256}.pdf`);
}

/** True if this content's file is already on disk (then there's nothing to write). */
export async function storedFileExists(sha256: string): Promise<boolean> {
  try {
    await fs.access(storedPathFor(sha256));
    return true;
  } catch {
    return false;
  }
}

export async function writeStoredFile(sha256: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(uploadsDir(), { recursive: true });
  await fs.writeFile(storedPathFor(sha256), bytes);
}

/**
 * Deletes an uploaded file's bytes. Refuses anything outside the uploads
 * directory -- a defensive check, not just a convention, since this is the
 * one place in the app that unlinks a file from a path built out of
 * database content. ENOENT (already gone) is not an error here: retention
 * cleanup is idempotent by design.
 */
export async function deleteStoredFile(sha256: string): Promise<void> {
  const dir = path.resolve(uploadsDir());
  const file = path.resolve(storedPathFor(sha256));
  if (!file.startsWith(dir + path.sep)) {
    throw new Error(`refusing to delete a path outside the uploads directory: ${file}`);
  }
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Recursive byte total of a directory; missing directories count as empty. */
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += (await fs.stat(full)).size;
    }
  }
  return total;
}

export interface StorageUsage {
  uploadsBytes: number;
  indexBytes: number;
  totalBytes: number;
}

/**
 * Measures actual disk usage -- the uploaded PDFs, the search index, and
 * the OCR cache -- rather than summing database-recorded sizes, so a cap
 * check can't be fooled by a file that grew after it was recorded, or miss
 * space held by something the database doesn't know about.
 */
export async function measureStorageUsage(indexDir: string): Promise<StorageUsage> {
  const uploadsBytes = await dirSizeBytes(uploadsDir());
  const indexBytes = await dirSizeBytes(indexDir);
  return { uploadsBytes, indexBytes, totalBytes: uploadsBytes + indexBytes };
}
