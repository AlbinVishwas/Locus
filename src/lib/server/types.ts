import type { Readable } from "node:stream";
import type { ErrorCode } from "../errors/catalog";

/**
 * A storage connector: where the PDFs live. Locus only ever reads from it. The interface is small on purpose, so
 * a new kind of server (SFTP, Azure Blob, SharePoint...) is one new file; see docs/connectors.md.
 *
 * Paths are always relative to the connector's root (the folder, or the bucket prefix), use "/" as the
 * separator whatever the operating system, and never start with "/" or contain "..".
 */

export interface RemoteFile {
  path: string;
  size: number;
  /** ISO timestamp of the last change on the server. */
  modifiedAt: string;
  /** The server's version tag, when it has one (S3). Changes whenever the content does. */
  etag: string | null;
}

export interface ConnectorTestResult {
  ok: boolean;
  /** A catalog code when not ok. */
  code?: ErrorCode;
  message: string;
  /** A few things worth showing next to a success: how many PDFs were seen in the first look, say. */
  details?: Record<string, string | number | boolean>;
}

/** Called for things the listing passed over, with a reason a person can read. */
export type SkipFn = (skip: { path: string; reason: string; isDirectory: boolean }) => void;

export interface StorageConnector {
  readonly type: "folder" | "s3";
  /** What people see: "folder /mnt/tenders", "s3 bucket tenders on minio.example.com". Never contains a secret. */
  readonly label: string;
  /** Every file under the root, recursively (not only PDFs: the caller filters). */
  list(signal: AbortSignal, onSkip?: SkipFn): AsyncIterable<RemoteFile>;
  /** One file's current details, or null if it's gone. */
  stat(path: string, signal?: AbortSignal): Promise<RemoteFile | null>;
  /** The file's bytes as a stream. Throws a ConnectorError (not-found, timeout, ...). `range` is inclusive. */
  read(path: string, signal?: AbortSignal, range?: { start: number; end: number }): Promise<Readable>;
  /** Cheap connectivity check for the Server page and `npm run doctor`. Never throws. */
  test(signal?: AbortSignal): Promise<ConnectorTestResult>;
  close(): Promise<void>;
}

export type ConnectorFailure = "unreachable" | "auth" | "not-found" | "timeout" | "config" | "other";

export class ConnectorError extends Error {
  constructor(
    readonly failure: ConnectorFailure,
    message: string
  ) {
    super(message);
    this.name = "ConnectorError";
  }

  get code(): ErrorCode {
    switch (this.failure) {
      case "auth":
        return "LOCUS-SERVER-002";
      case "not-found":
        return "LOCUS-SERVER-004";
      case "timeout":
        return "LOCUS-SERVER-005";
      case "config":
        return "LOCUS-SERVER-003";
      default:
        return "LOCUS-SERVER-001";
    }
  }
}

/** A path from a browser or the index, checked before it's joined to anything: relative, no "..", no drive letters, no NUL. */
export function cleanRelativePath(input: string): string | null {
  if (typeof input !== "string" || input === "" || input.includes("\0")) return null;
  const p = input.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) return null;
  return parts.join("/");
}
