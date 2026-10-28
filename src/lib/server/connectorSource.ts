import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { SkipRecord } from "../library/walk";
import { hasPdfHeader } from "../library/sources/localFile";
import { SourceFileError, StillChangingError, type LibrarySource, type OpenedFile, type SourceEntry } from "../library/sources/types";
import { withCode } from "../errors/catalog";
import { ConnectorError, type StorageConnector } from "./types";

/**
 * Adapts a storage connector to the indexer's source interface, so the storage server is indexed by the same
 * pipeline as every other source (resumable, one file at a time, failures listed and skipped, deleted files
 * swept from the index). The connector is only ever read from.
 *
 * Each PDF is streamed to a temp file for the moment it's being indexed and the temp file is deleted right
 * after (OpenedFile.cleanup); nothing from the server is kept.
 *
 * Change detection is (size, modifiedAt); for servers with version tags (S3) the tag is part of modifiedAt, so
 * a file replaced with same-size content and the same timestamp is still noticed. An unchanged file is never
 * downloaded.
 */

export interface ConnectorSourceOptions {
  id: string;
  name: string;
  connector: StorageConnector;
  maxFileBytes: number;
  /** A file changed this recently may still be being copied: wait this long before reading it. */
  settleSeconds: number;
  /** Runs before every scan; throws to stop it with a reason (the disk-space check). */
  beforeScan?: (signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface Locator {
  p: string;
  size: number;
  etag: string | null;
}

export class ConnectorSource implements LibrarySource {
  readonly kind = "server" as const;
  readonly id: string;
  readonly name: string;
  readonly label: string;

  constructor(private readonly o: ConnectorSourceOptions) {
    this.id = o.id;
    this.name = o.name;
    this.label = `storage server (${o.connector.label})`;
  }

  async *scan(signal: AbortSignal, onSkip: (skip: SkipRecord) => void, onOther?: () => void): AsyncIterable<SourceEntry> {
    if (this.o.beforeScan) await this.o.beforeScan(signal);
    const now = this.o.now ?? Date.now;
    const settleMs = this.o.settleSeconds * 1000;
    for await (const f of this.listing(signal, onSkip)) {
      if (!/\.pdf$/i.test(f.path)) {
        onOther?.();
        continue;
      }
      if (f.size > this.o.maxFileBytes) {
        onSkip({ relPath: f.path, reason: "too-large", isDirectory: false, detail: `skipped: too large (${f.size} bytes, limit ${this.o.maxFileBytes})` });
        continue;
      }
      const key = f.path.normalize("NFC");
      const locator: Locator = { p: f.path, size: f.size, etag: f.etag };
      const entry: SourceEntry = {
        key,
        displayName: key,
        locator: JSON.stringify(locator),
        sizeBytes: f.size,
        modifiedAt: f.etag ? `${f.modifiedAt}#${f.etag}` : f.modifiedAt,
      };
      const mtime = Date.parse(f.modifiedAt);
      if (settleMs > 0 && Number.isFinite(mtime) && now() - mtime < settleMs) entry.notBefore = new Date(mtime + settleMs).toISOString();
      yield entry;
    }
  }

  /** The connector's listing, with a problem on the server reported under its catalog code. */
  private async *listing(signal: AbortSignal, onSkip: (skip: SkipRecord) => void) {
    try {
      yield* this.o.connector.list(signal, (s) =>
        onSkip({ relPath: s.path, reason: s.isDirectory ? "permission-denied" : "unreadable-filename", isDirectory: s.isDirectory, detail: `skipped: ${s.reason}` })
      );
    } catch (err) {
      if (err instanceof ConnectorError) throw new Error(withCode(err.code, err.message));
      throw err;
    }
  }

  async open(entry: SourceEntry, tempDir: string, signal: AbortSignal): Promise<OpenedFile> {
    const loc = JSON.parse(entry.locator) as Locator;
    let stream;
    try {
      stream = await this.o.connector.read(loc.p, signal);
    } catch (err) {
      throw this.mapOpenError(err, loc.p);
    }
    const file = path.join(tempDir, `srv-${randomUUID()}.pdf`);
    const sha = createHash("sha256");
    let total = 0;
    let first: Buffer | null = null;
    const max = this.o.maxFileBytes;
    try {
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            total += chunk.length;
            if (total > max) throw new SourceFileError("too-large", `skipped: too large (over ${max} bytes)`);
            if (first === null) first = Buffer.from(chunk.subarray(0, 1024));
            sha.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(file),
        { signal }
      );
    } catch (err) {
      await fs.promises.rm(file, { force: true });
      if (err instanceof SourceFileError) throw err;
      if (signal.aborted) throw err;
      throw this.mapOpenError(err, loc.p);
    }
    // The file's size changed between the listing and the read: it's being written. Try again later, not a failure.
    if (total !== loc.size) {
      await fs.promises.rm(file, { force: true });
      throw new StillChangingError(`${loc.p} changed while it was being read (listed ${loc.size} bytes, read ${total})`);
    }
    if (!first || !hasPdfHeader(first)) {
      await fs.promises.rm(file, { force: true });
      throw new SourceFileError("not-a-pdf", "skipped: not a PDF (no %PDF- header)");
    }
    return { path: file, sha256: sha.digest("hex"), sizeBytes: total, modifiedAt: entry.modifiedAt, cleanup: () => fs.promises.rm(file, { force: true }) };
  }

  /** A problem with the server is retried later (StillChangingError defers the file); only a problem with this file is recorded against it. */
  private mapOpenError(err: unknown, p: string): Error {
    if (err instanceof SourceFileError || err instanceof StillChangingError) return err;
    if (err instanceof ConnectorError) {
      if (err.failure === "not-found") return new SourceFileError("vanished", `${p}: it was removed from the server`);
      if (err.failure === "auth") return new SourceFileError("permission-denied", `${p}: the server refused to give this file (no read access)`);
      if (err.failure === "unreachable" || err.failure === "timeout") return new StillChangingError(`${p}: the server didn't answer (${err.message}); trying again later`);
      return new SourceFileError("unreadable", err.message);
    }
    return new SourceFileError("unreadable", `${p}: ${err instanceof Error ? err.message : String(err)}`);
  }

  async close(): Promise<void> {
    await this.o.connector.close().catch(() => {});
  }
}
