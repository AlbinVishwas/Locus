import path from "node:path";
import { envWithFallback } from "../env";
import { diskInfo } from "../server/disk";

/**
 * Upload settings, env-configurable the same way the indexer and the chat
 * route are. See docs/sharing.md for why the defaults are what they are.
 */

/**
 * Uploads (and the in-chat document search that reads them) are a local,
 * trusted-sharing feature, not something to expose by accident on a public
 * deployment. Same fail-closed shape as isUrlContextEnabled in urlContext.ts.
 */
export function uploadsEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    envWithFallback("LOCUS_ENABLE_UPLOADS", "ASSAY_ENABLE_UPLOADS") === "true"
  );
}

/**
 * 100 MB: the largest tender PDF measured during development was 11 MB, but
 * real scanned tenders have reached 32 MB, so this leaves room for the rest.
 * It matches the ~100 MB request-body ceiling a Cloudflare quick tunnel
 * imposes (see docs/sharing.md); a file right at this size can still be
 * refused by the tunnel itself once the multipart envelope is added.
 */
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 20: comfortably above the 13-document sample set this feature was built
 * against, while still keeping one conversation's worth of uploads a small,
 * reviewable set rather than an open-ended document store.
 */
const DEFAULT_MAX_FILES_PER_CONVERSATION = 20;

/** 5 GB: the least the default cap ever is (the full 13-document sample set is under 40 MB). */
const DEFAULT_STORAGE_CAP_BYTES = 5 * 1024 * 1024 * 1024;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

export function uploadsDir(): string {
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.UPLOADS_DIR ?? path.join(process.cwd(), "data/uploads")
  );
}

export function maxUploadFileBytes(): number {
  return intEnv("MAX_UPLOAD_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
}

export function maxFilesPerConversation(): number {
  return intEnv("MAX_FILES_PER_CONVERSATION", DEFAULT_MAX_FILES_PER_CONVERSATION);
}

/**
 * 500: a folder pick uploads every PDF in it, one request each, so the number
 * is bounded to keep one pick to a few hours of OCR at worst and a single
 * account's index reviewable. A bigger collection is a job for the admin's
 * library folders (Sources), which index on the laptop itself.
 */
const DEFAULT_MAX_FOLDER_FILES = 500;

/**
 * 90 MB: a Cloudflare quick tunnel refuses request bodies over ~100 MB, and a
 * file's multipart envelope adds to it, so a picked folder's files are held a
 * little under that (and never above MAX_UPLOAD_FILE_BYTES).
 */
const TUNNEL_SAFE_FILE_BYTES = 90 * 1024 * 1024;

export function maxFolderFiles(): number {
  return intEnv("MAX_FOLDER_FILES", DEFAULT_MAX_FOLDER_FILES);
}

export function maxFolderFileBytes(): number {
  return Math.min(maxUploadFileBytes(), TUNNEL_SAFE_FILE_BYTES);
}

/** How many files the browser sends at once (LOCUS_UPLOAD_PARALLEL, 1-8, default 4): enough to keep the connection full while the server reads the text of the next file. */
export function uploadParallel(): number {
  return Math.min(8, Math.max(1, intEnv("LOCUS_UPLOAD_PARALLEL", 4)));
}

/** Folder pick sessions use ids that start with this; see /api/folders. */
export const FOLDER_ID_PREFIX = "fld_";

/**
 * STORAGE_CAP_BYTES, or -- when it isn't set -- half of the disk that holds the uploads (never under 5 GB), so the
 * default scales with the machine instead of being one number for every laptop. The free-disk reserve
 * (uploads/space.ts) still applies on top.
 */
export function storageCapBytes(): number {
  const raw = process.env.STORAGE_CAP_BYTES;
  if (raw !== undefined && raw !== "") return intEnv("STORAGE_CAP_BYTES", DEFAULT_STORAGE_CAP_BYTES);
  try {
    return Math.max(DEFAULT_STORAGE_CAP_BYTES, Math.floor(diskInfo(uploadsDir()).totalBytes / 2));
  } catch {
    return DEFAULT_STORAGE_CAP_BYTES;
  }
}

/**
 * Off (null) unless explicitly set: an uploaded file, once uploaded, stays
 * until the user removes it or deletes the conversation -- deleting things
 * out from under someone on a timer is more surprising than useful as a
 * default. Set LOCUS_RETENTION_DAYS to bring automatic expiry back (e.g.
 * for a shared machine that should forget files on its own) with no code
 * change.
 */
export function retentionDays(): number | null {
  const raw = process.env.LOCUS_RETENTION_DAYS;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`LOCUS_RETENTION_DAYS must be a positive number, got "${raw}"`);
  }
  return value;
}

export function retentionMs(): number | null {
  const days = retentionDays();
  return days === null ? null : days * 24 * 60 * 60 * 1000;
}
