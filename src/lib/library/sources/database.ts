import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SkipRecord } from "../walk";
import { connectReadOnly, type DbConnection } from "./db/connection";
import {
  chunkSql,
  columnsSql,
  contentColumnOf,
  listSql,
  parseDbUrl,
  redactSecrets,
  redactUrl,
  toIso,
  type ContentColumn,
} from "./db/sql";
import { hasPdfHeader, openLocalPdf } from "./localFile";
import { SourceFileError, type LibrarySource, type OpenedFile, type SourceEntry } from "./types";

/**
 * LIBRARY_DB_URL + LIBRARY_DB_QUERY: documents listed by a read-only query
 * returning id, filename, modified_at, and either file_path (read in place)
 * or file_bytes (streamed in chunks to the temp folder on the external
 * drive, then deleted). Rows are fetched in batches, so 50k rows are never
 * in memory at once; file bytes are fetched one chunk at a time, so a large
 * file never is either.
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;

export interface DatabaseSourceOptions {
  /** The registry id, when this source comes from the Sources page (otherwise derived from the URL and query). */
  id?: string;
  name?: string;
  /** A file_path value must pass this (inside the allowed roots) or the row is skipped. */
  pathAllowed?: (p: string) => boolean;
  batchSize: number;
  maxFileBytes: number;
  settleSeconds: number;
  /** Injectable for tests. */
  connect?: (url: string) => Promise<DbConnection>;
  chunkBytes?: number;
}

export class DatabaseSource implements LibrarySource {
  readonly kind = "database" as const;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  // The connection URL carries the password. A #private field is not an
  // enumerable property, so JSON.stringify, a console.log or a debugger
  // dump of this object cannot reveal it; it exists only to connect.
  readonly #url: string;
  private conn: DbConnection | null = null;
  private content: ContentColumn | null = null;

  constructor(
    url: string,
    private readonly query: string,
    private readonly options: DatabaseSourceOptions
  ) {
    parseDbUrl(url);
    this.#url = url;
    const redacted = redactUrl(url);
    this.id = options.id ?? `db:${createHash("sha1").update(`${redacted.replace(":***@", "@")}\n${query}`).digest("hex").slice(0, 16)}`;
    this.name = options.name ?? "Database";
    this.label = `database ${redacted}`;
  }

  private async connection(): Promise<{ conn: DbConnection; content: ContentColumn }> {
    if (!this.conn) {
      const conn = await (this.options.connect ?? connectReadOnly)(this.#url);
      try {
        this.content = contentColumnOf(await conn.columns(columnsSql(this.query)));
      } catch (err) {
        await conn.close();
        throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), this.#url));
      }
      this.conn = conn;
    }
    return { conn: this.conn, content: this.content! };
  }

  async *scan(signal: AbortSignal, onSkip: (skip: SkipRecord) => void): AsyncIterable<SourceEntry> {
    const { conn, content } = await this.connection();
    let lastId: unknown = undefined;
    while (!signal.aborted) {
      const sql = listSql(conn.dialect, this.query, content, this.options.batchSize, lastId !== undefined);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await conn.all(sql, lastId !== undefined ? [lastId] : []);
      } catch (err) {
        throw new Error(`LIBRARY_DB_QUERY failed: ${redactSecrets(err instanceof Error ? err.message : String(err), this.#url)}`);
      }
      if (rows.length === 0) return;
      for (const row of rows) {
        const id = String(row.id);
        const filename = String(row.filename ?? "");
        const displayName = `db:${id} · ${filename}`;
        let sizeBytes: number | null = null;
        let locator: string;
        if (content === "file_path") {
          locator = String(row.file_path ?? "");
          if (this.options.pathAllowed && !this.options.pathAllowed(locator)) {
            onSkip({ relPath: displayName, reason: "not-allowed", isDirectory: false, detail: "the file's location isn't inside an allowed folder" });
            continue;
          }
          try {
            sizeBytes = fs.statSync(locator).size;
          } catch {
            sizeBytes = null; // open() will report what's wrong with it
          }
        } else {
          locator = `row:${id}`;
          sizeBytes = row.byte_length === null || row.byte_length === undefined ? null : Number(row.byte_length);
        }
        if (sizeBytes !== null && sizeBytes > this.options.maxFileBytes) {
          onSkip({ relPath: displayName, reason: "too-large", isDirectory: false, detail: `skipped: too large (${sizeBytes} bytes)` });
          continue;
        }
        yield { key: id, displayName, locator, sizeBytes, modifiedAt: toIso(row.modified_at) };
      }
      lastId = rows[rows.length - 1].id;
      if (rows.length < this.options.batchSize) return;
    }
  }

  async open(entry: SourceEntry, tempDir: string, signal: AbortSignal): Promise<OpenedFile> {
    const { conn, content } = await this.connection();
    if (content === "file_path") {
      if (this.options.pathAllowed && !this.options.pathAllowed(entry.locator)) {
        throw new SourceFileError("not-allowed", "the file's location isn't inside an allowed folder");
      }
      // Read in place, exactly like a folder source. The database's
      // modified_at is the change signal, so no settle wait on the file.
      return openLocalPdf(entry.locator, { maxFileBytes: this.options.maxFileBytes, settleMs: 0, signal });
    }

    const chunkBytes = this.options.chunkBytes ?? CHUNK_BYTES;
    const file = path.join(tempDir, `db-${randomUUID()}.pdf`);
    const hash = createHash("sha256");
    const handle = await fs.promises.open(file, "wx");
    let total = 0;
    let first: Buffer | null = null;
    try {
      const sql = chunkSql(conn.dialect, this.query);
      for (let offset = 1; ; offset += chunkBytes) {
        if (signal.aborted) throw new Error("aborted");
        let rows: Array<Record<string, unknown>>;
        try {
          rows = await conn.all(sql, [offset, chunkBytes, entry.key]);
        } catch (err) {
          throw new SourceFileError("unreadable", redactSecrets(err instanceof Error ? err.message : String(err), this.#url));
        }
        if (rows.length === 0) throw new SourceFileError("vanished", "row no longer returned by LIBRARY_DB_QUERY");
        const raw = rows[0].chunk;
        if (raw === null || raw === undefined) throw new SourceFileError("unreadable", "file_bytes is NULL");
        const chunk = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw), "binary");
        if (chunk.length === 0) break;
        if (first === null) first = Buffer.from(chunk.subarray(0, 1024));
        total += chunk.length;
        if (total > this.options.maxFileBytes) {
          throw new SourceFileError("too-large", `skipped: too large (over ${this.options.maxFileBytes} bytes)`);
        }
        hash.update(chunk);
        await handle.write(chunk);
        if (chunk.length < chunkBytes) break;
      }
    } catch (err) {
      await handle.close();
      await fs.promises.rm(file, { force: true });
      throw err;
    }
    await handle.close();
    if (!first || !hasPdfHeader(first)) {
      await fs.promises.rm(file, { force: true });
      throw new SourceFileError("not-a-pdf", "skipped: not a PDF (no %PDF- header)");
    }
    return {
      path: file,
      sha256: hash.digest("hex"),
      sizeBytes: total,
      modifiedAt: entry.modifiedAt,
      cleanup: () => fs.promises.rm(file, { force: true }),
    };
  }

  async close(): Promise<void> {
    await this.conn?.close();
    this.conn = null;
  }
}
