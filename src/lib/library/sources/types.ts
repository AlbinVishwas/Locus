import type { FailureKind } from "../schema";
import type { SkipRecord } from "../walk";

/**
 * Where library documents come from. Folder and database sources exist
 * today; S3, SharePoint or Google Drive fit the same shape later: `scan`
 * pages through the provider's listing, `open` streams one object into the
 * temp folder on the external drive. Nothing else in the pipeline needs to
 * know which kind of source a document came from.
 */

export interface SourceEntry {
  /** Stable identity within the source: a folder-relative path (NFC) or a database row id. */
  key: string;
  /** What results show: the folder-relative path, or "db:<id> · <filename>". Never an absolute path. */
  displayName: string;
  /** How `open` finds it again (an absolute path, a row id). Stays in the library index, never reaches a browser. */
  locator: string;
  sizeBytes: number | null;
  /** ISO. Change detection compares (sizeBytes, modifiedAt); content is hashed only when those move. */
  modifiedAt: string | null;
  /** Set when the file looks like it's still being written: don't try it before this time. */
  notBefore?: string;
}

export interface OpenedFile {
  /** A local path poppler can read: the original file for a folder (never copied), a temp file for database bytes. */
  path: string;
  sha256: string;
  sizeBytes: number;
  modifiedAt: string | null;
  /** Deletes the temp copy, if one was made. */
  cleanup(): Promise<void>;
}

export interface LibrarySource {
  readonly id: string;
  readonly kind: "folder" | "database" | "upload";
  /** For status and logs. Never contains credentials or absolute paths a browser could see. */
  readonly label: string;
  /** Streams entries with constant memory. Problems go to `onSkip`; the scan carries on. */
  scan(signal: AbortSignal, onSkip: (skip: SkipRecord) => void, onOther?: () => void): AsyncIterable<SourceEntry>;
  open(entry: SourceEntry, tempDir: string, signal: AbortSignal): Promise<OpenedFile>;
  close(): Promise<void>;
}

/** A file that can't be indexed, for a reason worth recording. */
export class SourceFileError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string
  ) {
    super(message);
  }
}

/** The file changed while it was being read (still being copied?): try again later, not a failure. */
export class StillChangingError extends Error {}
