import path from "node:path";

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
    process.env.NODE_ENV !== "production" || process.env.ASSAY_ENABLE_UPLOADS === "true"
  );
}

/**
 * 50 MB: the largest tender PDF measured during development was 11 MB, so
 * this is generous headroom for a real tender document while staying well
 * under the ~100 MB request-body ceiling a Cloudflare quick tunnel imposes
 * (see docs/sharing.md) -- a file that would fail at the tunnel fails with a
 * clear message here instead, before any upload is attempted.
 */
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 20: comfortably above the 13-document sample set this feature was built
 * against, while still keeping one conversation's worth of uploads a small,
 * reviewable set rather than an open-ended document store.
 */
const DEFAULT_MAX_FILES_PER_CONVERSATION = 20;

/** 5 GB: a laptop-friendly default that comfortably holds many conversations' worth of tender PDFs (the full 13-document sample set is under 40 MB). */
const DEFAULT_STORAGE_CAP_BYTES = 5 * 1024 * 1024 * 1024;

/** 14 days: long enough to finish working a tender, short enough that a laptop shared occasionally doesn't quietly accumulate client documents forever. */
const DEFAULT_RETENTION_DAYS = 14;

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

export function storageCapBytes(): number {
  return intEnv("STORAGE_CAP_BYTES", DEFAULT_STORAGE_CAP_BYTES);
}

export function retentionDays(): number {
  return intEnv("RETENTION_DAYS", DEFAULT_RETENTION_DAYS);
}

export function retentionMs(): number {
  return retentionDays() * 24 * 60 * 60 * 1000;
}
