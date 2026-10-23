import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUploadedDocument, openIndex } from "../../../../scripts/indexer/store";
import { connectReadOnly, type DbConnection } from "./db/connection";
import {
  chunkSql,
  columnsSql,
  contentColumnOf,
  listSql,
  parseDbUrl,
  readOnlySessionSql,
  redactSecrets,
  redactUrl,
  toIso,
  wrappableQuery,
} from "./db/sql";
import { DatabaseSource } from "./database";
import { FolderSource } from "./folder";
import { openLocalPdf } from "./localFile";
import { SourceFileError, StillChangingError, type SourceEntry } from "./types";
import { UploadSource } from "./upload";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-sources-"));
});

afterEach(() => {
  fs.chmodSync(dir, 0o755);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const PDF = (body: string) => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`);
const signal = () => new AbortController().signal;

async function collect(source: { scan: (s: AbortSignal, onSkip: (x: unknown) => void) => AsyncIterable<SourceEntry> }) {
  const entries: SourceEntry[] = [];
  const skips: unknown[] = [];
  for await (const e of source.scan(signal(), (s) => skips.push(s))) entries.push(e);
  return { entries, skips };
}

describe("openLocalPdf", () => {
  it("hashes by streaming and returns the original path (never a copy)", async () => {
    const file = path.join(dir, "a.pdf");
    fs.writeFileSync(file, PDF("x"));
    const opened = await openLocalPdf(file, { maxFileBytes: 1e9, settleMs: 0 });
    expect(opened.path).toBe(file);
    expect(opened.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readdirSync(dir)).toEqual(["a.pdf"]);
  });

  it("classifies each problem", async () => {
    fs.writeFileSync(path.join(dir, "text.pdf"), "no header here");
    await expect(openLocalPdf(path.join(dir, "text.pdf"), { maxFileBytes: 1e9, settleMs: 0 })).rejects.toMatchObject({ kind: "not-a-pdf" });
    await expect(openLocalPdf(path.join(dir, "gone.pdf"), { maxFileBytes: 1e9, settleMs: 0 })).rejects.toMatchObject({ kind: "vanished" });
    fs.writeFileSync(path.join(dir, "big.pdf"), PDF("x".repeat(100)));
    await expect(openLocalPdf(path.join(dir, "big.pdf"), { maxFileBytes: 10, settleMs: 0 })).rejects.toMatchObject({ kind: "too-large" });
    fs.writeFileSync(path.join(dir, "locked.pdf"), PDF("x"));
    fs.chmodSync(path.join(dir, "locked.pdf"), 0o000);
    await expect(openLocalPdf(path.join(dir, "locked.pdf"), { maxFileBytes: 1e9, settleMs: 0 })).rejects.toMatchObject({ kind: "permission-denied" });
  });

  it("accepts a header after leading junk (allowed in the first 1024 bytes)", async () => {
    fs.writeFileSync(path.join(dir, "junk.pdf"), Buffer.concat([Buffer.alloc(100, 0x20), PDF("x")]));
    await expect(openLocalPdf(path.join(dir, "junk.pdf"), { maxFileBytes: 1e9, settleMs: 0 })).resolves.toBeTruthy();
  });

  it("a file modified moments ago is 'still changing' (try later), not a failure", async () => {
    fs.writeFileSync(path.join(dir, "fresh.pdf"), PDF("x"));
    await expect(openLocalPdf(path.join(dir, "fresh.pdf"), { maxFileBytes: 1e9, settleMs: 60_000 })).rejects.toBeInstanceOf(StillChangingError);
  });

  it("a file that grows while it's being hashed is 'still changing'", async () => {
    const file = path.join(dir, "growing.pdf");
    fs.writeFileSync(file, Buffer.concat([PDF("x"), Buffer.alloc(4 * 1024 * 1024)]));
    const realStat = fs.promises.stat;
    let n = 0;
    vi.spyOn(fs.promises, "stat").mockImplementation(async (p, ...rest) => {
      const s = await realStat(p, ...(rest as []));
      // The second stat (after hashing) sees a different size.
      return ++n === 2 ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: s.size + 1 }) : s;
    });
    await expect(openLocalPdf(file, { maxFileBytes: 1e9, settleMs: 0 })).rejects.toBeInstanceOf(StillChangingError);
  });
});

describe("FolderSource", () => {
  it("lists PDFs with folder-relative keys and display names (never absolute), and a stable id", async () => {
    fs.mkdirSync(path.join(dir, "lib", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "lib", "sub", "a.pdf"), PDF("a"));
    fs.writeFileSync(path.join(dir, "lib", "b.txt"), "x");
    const src = new FolderSource(path.join(dir, "lib"), { include: ["**/*.pdf"], exclude: [], crossDevice: false, maxFileBytes: 1e9, settleSeconds: 0 });
    const { entries } = await collect(src);
    expect(entries.map((e) => [e.key, e.displayName])).toEqual([["sub/a.pdf", "sub/a.pdf"]]);
    expect(src.id).toMatch(/^folder:[0-9a-f]{16}$/);
    expect(new FolderSource(path.join(dir, "lib"), { include: [], exclude: [], crossDevice: false, maxFileBytes: 1, settleSeconds: 0 }).id).toBe(src.id);
  });

  it("marks a just-modified file to wait (notBefore) and reports too-large files as skips", async () => {
    fs.mkdirSync(path.join(dir, "lib"));
    fs.writeFileSync(path.join(dir, "lib", "fresh.pdf"), PDF("a"));
    fs.writeFileSync(path.join(dir, "lib", "big.pdf"), PDF("a".repeat(1000)));
    const src = new FolderSource(path.join(dir, "lib"), { include: ["**/*.pdf"], exclude: [], crossDevice: false, maxFileBytes: 500, settleSeconds: 60 });
    const { entries, skips } = await collect(src);
    expect(entries.map((e) => [e.key, typeof e.notBefore])).toEqual([["fresh.pdf", "string"]]);
    expect(skips).toEqual([expect.objectContaining({ relPath: "big.pdf", reason: "too-large" })]);
  });
});

describe("database SQL generation (all three dialects)", () => {
  const Q = "SELECT doc_id AS id, name AS filename, updated AS modified_at, path AS file_path FROM docs WHERE active = 1;";

  it("wraps the query unedited, minus a trailing semicolon; refuses multiple statements", () => {
    expect(wrappableQuery(Q)).toBe(Q.slice(0, -1));
    expect(() => wrappableQuery("SELECT 1; DROP TABLE docs")).toThrow(/single SELECT/);
    expect(() => wrappableQuery("  ;  ")).toThrow(/empty/);
  });

  it("lists in id-ordered batches with a bound keyset cursor (never selecting file_bytes)", () => {
    const q = Q.slice(0, -1);
    expect(listSql("sqlite", Q, "file_path", 500, false)).toBe(
      `SELECT locus_q.id AS id, locus_q.filename AS filename, locus_q.modified_at AS modified_at, locus_q.file_path AS file_path FROM (${q}) AS locus_q ORDER BY locus_q.id LIMIT 500`
    );
    expect(listSql("postgres", Q, "file_bytes", 100, true)).toBe(
      `SELECT locus_q.id AS id, locus_q.filename AS filename, locus_q.modified_at AS modified_at, octet_length(locus_q.file_bytes) AS byte_length FROM (${q}) AS locus_q WHERE locus_q.id > $1 ORDER BY locus_q.id LIMIT 100`
    );
    expect(listSql("mysql", Q, "file_bytes", 100, true)).toBe(
      `SELECT locus_q.id AS id, locus_q.filename AS filename, locus_q.modified_at AS modified_at, octet_length(locus_q.file_bytes) AS byte_length FROM (${q}) AS locus_q WHERE locus_q.id > ? ORDER BY locus_q.id LIMIT 100`
    );
    expect(listSql("sqlite", Q, "file_bytes", 1, true)).toContain("length(CAST(locus_q.file_bytes AS BLOB)) AS byte_length");
    for (const d of ["sqlite", "postgres", "mysql"] as const) {
      expect(listSql(d, Q, "file_bytes", 10, true)).not.toMatch(/locus_q\.file_bytes AS file_bytes|SELECT \*/);
    }
    expect(() => listSql("sqlite", Q, "file_path", 1.5, false)).toThrow(/positive integer/);
  });

  it("fetches bytes in chunks, offset/length/id all bound", () => {
    const q = Q.slice(0, -1);
    expect(chunkSql("sqlite", Q)).toBe(`SELECT substr(CAST(locus_q.file_bytes AS BLOB), ?, ?) AS chunk FROM (${q}) AS locus_q WHERE locus_q.id = ?`);
    expect(chunkSql("postgres", Q)).toBe(`SELECT substring(locus_q.file_bytes from $1 for $2) AS chunk FROM (${q}) AS locus_q WHERE locus_q.id = $3`);
    expect(chunkSql("mysql", Q)).toBe(`SELECT SUBSTRING(locus_q.file_bytes, ?, ?) AS chunk FROM (${q}) AS locus_q WHERE locus_q.id = ?`);
  });

  it("checks columns with a zero-row query, and requires exactly one of file_path / file_bytes", () => {
    expect(columnsSql(Q)).toBe(`SELECT * FROM (${Q.slice(0, -1)}) AS locus_q WHERE 1 = 0`);
    expect(contentColumnOf(["ID", "filename", "modified_at", "file_path"])).toBe("file_path");
    expect(contentColumnOf(["id", "filename", "modified_at", "file_bytes"])).toBe("file_bytes");
    expect(() => contentColumnOf(["id", "filename", "file_path"])).toThrow(/missing: modified_at/);
    expect(() => contentColumnOf(["id", "filename", "modified_at", "file_path", "file_bytes"])).toThrow(/exactly one/);
    expect(() => contentColumnOf(["id", "filename", "modified_at"])).toThrow(/exactly one/);
  });

  it("read-only session statements per dialect", () => {
    expect(readOnlySessionSql("postgres")).toEqual(["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"]);
    expect(readOnlySessionSql("mysql")).toEqual(["SET SESSION TRANSACTION READ ONLY"]);
    expect(readOnlySessionSql("sqlite")).toEqual(["PRAGMA query_only = ON"]);
  });

  it("parses URLs and never shows a password", () => {
    expect(parseDbUrl("sqlite:///Volumes/x/docs.db")).toEqual({ dialect: "sqlite", file: "/Volumes/x/docs.db" });
    expect(parseDbUrl("postgres://u:p@h/db").dialect).toBe("postgres");
    expect(parseDbUrl("mysql://u:p@h/db").dialect).toBe("mysql");
    expect(() => parseDbUrl("mongodb://u:hunter2@h/db")).toThrow(/sqlite:, postgres:\/\/ or mysql:\/\//);
    expect(() => parseDbUrl("mongodb://u:hunter2@h/db")).not.toThrow(/hunter2/);
    expect(redactUrl("postgres://reader:s3cr3t%21@db.local:5432/docs?sslmode=require")).toBe("postgres://reader:***@db.local:5432/docs?sslmode=require");
    expect(redactUrl("mysql://reader@db/docs?password=abc")).toBe("mysql://reader@db/docs?password=***");
    const url = "postgres://reader:s3cr3t%21@db.local/docs";
    expect(redactSecrets(`connect failed for ${url}: password authentication failed (s3cr3t!)`, url)).toBe(
      "connect failed for postgres://reader:***@db.local/docs: password authentication failed (***)"
    );
  });

  it("normalizes modified_at from the shapes drivers return", () => {
    expect(toIso(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(toIso("2026-01-02 03:04:05")).toBe("2026-01-02T03:04:05.000Z");
    expect(toIso(1767323045)).toBe("2026-01-02T03:04:05.000Z");
    expect(toIso(null)).toBeNull();
  });
});

describe("Postgres / MySQL connections (drivers mocked: no servers here)", () => {
  it("Postgres: read-only session at connect, both via the connection option and a SET", async () => {
    const queries: string[] = [];
    let config: Record<string, unknown> = {};
    vi.doMock("pg", () => ({
      default: {
        Client: class {
          constructor(c: Record<string, unknown>) {
            config = c;
          }
          async connect() {}
          async query(sql: string) {
            queries.push(sql);
            return { rows: [], fields: [] };
          }
          async end() {}
        },
      },
    }));
    // connectReadOnly imports the driver lazily, so it picks up the mock.
    const conn = await connectReadOnly("postgres://reader:pw@h/db");
    expect(config.options).toBe("-c default_transaction_read_only=on");
    expect(queries).toEqual(["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"]);
    await conn.close();
    vi.doUnmock("pg");
  });

  it("MySQL: read-only session at connect", async () => {
    const queries: string[] = [];
    vi.doMock("mysql2/promise", () => ({
      createConnection: async () => ({
        query: async (sql: string) => {
          queries.push(sql);
        },
        execute: async () => [[], []],
        end: async () => {},
      }),
    }));
    const conn = await connectReadOnly("mysql://reader:pw@h/db");
    expect(queries).toEqual(["SET SESSION TRANSACTION READ ONLY"]);
    await conn.close();
    vi.doUnmock("mysql2/promise");
  });

  it("a connection error never carries the password", async () => {
    vi.doMock("mysql2/promise", () => ({
      createConnection: async (url: string) => {
        throw new Error(`Access denied using ${url}`);
      },
    }));
    const err = (await connectReadOnly("mysql://reader:topsecretpw@h/db").catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("mysql://reader:***@h/db");
    expect(err.message).not.toContain("topsecretpw");
    vi.doUnmock("mysql2/promise");
  });
});

describe("DatabaseSource against a local SQLite fixture", () => {
  function fixtureDb(rows: number, mode: "path" | "bytes", blob?: Buffer): string {
    const file = path.join(dir, "docs.db");
    const db = new Database(file);
    db.exec("CREATE TABLE docs (doc_id INTEGER PRIMARY KEY, name TEXT, updated TEXT, path TEXT, data BLOB, active INTEGER)");
    const insert = db.prepare("INSERT INTO docs VALUES (?, ?, ?, ?, ?, 1)");
    db.transaction(() => {
      for (let i = 1; i <= rows; i++) {
        const p = path.join(dir, `f${i}.pdf`);
        if (mode === "path" && i <= 3) fs.writeFileSync(p, PDF(`file ${i}`));
        insert.run(i, `File ${i}.pdf`, `2026-01-0${(i % 9) + 1} 10:00:00`, p, mode === "bytes" ? (blob ?? PDF(`bytes ${i}`)) : null);
      }
    })();
    db.close();
    return file;
  }
  const PATH_Q = "SELECT doc_id AS id, name AS filename, updated AS modified_at, path AS file_path FROM docs WHERE active = 1";
  const BYTES_Q = "SELECT doc_id AS id, name AS filename, updated AS modified_at, data AS file_bytes FROM docs";

  it("file_path rows: listed with db:<id> names, read in place", async () => {
    const file = fixtureDb(3, "path");
    const src = new DatabaseSource(`sqlite://${file}`, PATH_Q, { batchSize: 2, maxFileBytes: 1e9, settleSeconds: 0 });
    const { entries } = await collect(src);
    expect(entries.map((e) => [e.key, e.displayName, e.modifiedAt])).toEqual([
      ["1", "db:1 · File 1.pdf", "2026-01-02T10:00:00.000Z"],
      ["2", "db:2 · File 2.pdf", "2026-01-03T10:00:00.000Z"],
      ["3", "db:3 · File 3.pdf", "2026-01-04T10:00:00.000Z"],
    ]);
    const opened = await src.open(entries[1], path.join(dir, "tmp"), signal());
    expect(opened.path).toBe(path.join(dir, "f2.pdf"));
    await src.close();
  });

  it("file_bytes rows: streamed in chunks to the temp folder (a blob bigger than one chunk), hashed, deleted by cleanup", async () => {
    const big = Buffer.concat([PDF("big"), Buffer.alloc(3 * 1024 * 1024 + 123, 7)]);
    const file = fixtureDb(1, "bytes", big);
    const tmp = path.join(dir, "tmp");
    fs.mkdirSync(tmp);
    const src = new DatabaseSource(`sqlite://${file}`, BYTES_Q, { batchSize: 10, maxFileBytes: 1e9, settleSeconds: 0, chunkBytes: 1024 * 1024 });
    const { entries } = await collect(src);
    expect(entries[0].sizeBytes).toBe(big.length);
    const opened = await src.open(entries[0], tmp, signal());
    expect(path.dirname(opened.path)).toBe(tmp);
    expect(fs.readFileSync(opened.path).equals(big)).toBe(true);
    const { createHash } = await import("node:crypto");
    expect(opened.sha256).toBe(createHash("sha256").update(big).digest("hex"));
    await opened.cleanup();
    expect(fs.readdirSync(tmp)).toEqual([]);
    await src.close();
  });

  it("fetches in batches: 2,000 rows with batch size 100 never returns more than 100 rows at once, and only as they're consumed", async () => {
    const file = fixtureDb(2000, "bytes");
    const sizes: number[] = [];
    const src = new DatabaseSource(`sqlite://${file}`, BYTES_Q, {
      batchSize: 100,
      maxFileBytes: 1e9,
      settleSeconds: 0,
      connect: async (url) => {
        const real = await connectReadOnly(url);
        return {
          dialect: real.dialect,
          columns: (sql) => real.columns(sql),
          all: async (sql, params) => {
            const rows = await real.all(sql, params);
            if (sql.includes("ORDER BY")) sizes.push(rows.length);
            return rows;
          },
          close: () => real.close(),
        } satisfies DbConnection;
      },
    });
    let n = 0;
    for await (const e of src.scan(signal(), () => {})) {
      void e;
      n++;
      if (n === 150) expect(sizes).toEqual([100, 100]);
    }
    expect(n).toBe(2000);
    expect(Math.max(...sizes)).toBe(100);
    // 20 full batches, then one empty one that says the listing is done.
    expect(sizes).toEqual([...Array(20).fill(100), 0]);
    await src.close();
  });

  it("is read-only: a write through the source's connection fails", async () => {
    const file = fixtureDb(1, "path");
    const conn = await connectReadOnly(`sqlite://${file}`);
    // RETURNING makes these statements return rows, so .all() really runs the write.
    await expect(conn.all("DELETE FROM docs RETURNING doc_id", [])).rejects.toThrow(/readonly|read-only/i);
    await expect(conn.all("INSERT INTO docs (doc_id) VALUES (99) RETURNING doc_id", [])).rejects.toThrow(/readonly|read-only/i);
    await conn.close();
    const db = new Database(file, { readonly: true });
    expect(db.prepare("SELECT count(*) FROM docs").pluck().get()).toBe(1);
    db.close();
  });

  it("explains a query missing a required column", async () => {
    const file = fixtureDb(1, "path");
    const src = new DatabaseSource(`sqlite://${file}`, "SELECT doc_id AS id, name AS filename FROM docs", { batchSize: 10, maxFileBytes: 1e9, settleSeconds: 0 });
    await expect(collect(src)).rejects.toThrow(/missing: modified_at/);
  });

  it("a row too large is a skip; a non-PDF blob is not-a-pdf", async () => {
    const file = fixtureDb(1, "bytes", Buffer.from("not a pdf at all"));
    const small = new DatabaseSource(`sqlite://${file}`, BYTES_Q, { batchSize: 10, maxFileBytes: 5, settleSeconds: 0 });
    const { entries, skips } = await collect(small);
    expect(entries).toEqual([]);
    expect(skips).toEqual([expect.objectContaining({ reason: "too-large" })]);
    await small.close();
    const src = new DatabaseSource(`sqlite://${file}`, BYTES_Q, { batchSize: 10, maxFileBytes: 1e9, settleSeconds: 0 });
    const got = await collect(src);
    fs.mkdirSync(path.join(dir, "tmp"));
    await expect(src.open(got.entries[0], path.join(dir, "tmp"), signal())).rejects.toMatchObject({ kind: "not-a-pdf" });
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
    await src.close();
  });

  it("the source id and label never contain the password", () => {
    const a = new DatabaseSource("postgres://reader:hunter2@db/docs", PATH_Q, { batchSize: 1, maxFileBytes: 1, settleSeconds: 0 });
    expect(a.label).toBe("database postgres://reader:***@db/docs");
    expect(a.id).not.toContain("hunter2");
    const b = new DatabaseSource("postgres://reader:different@db/docs", PATH_Q, { batchSize: 1, maxFileBytes: 1, settleSeconds: 0 });
    // A password change isn't a different source.
    expect(b.id).toBe(a.id);
  });
});

describe("UploadSource", () => {
  it("lists one session's uploads from the session index and opens their stored files, writing nothing", async () => {
    process.env.UPLOADS_DIR = path.join(dir, "uploads");
    const indexFile = path.join(dir, "index", "search.db");
    const db = openIndex(indexFile);
    insertUploadedDocument(db, {
      conversationId: "c1",
      originalFilename: "Notice.pdf",
      storedFilename: "abc.pdf",
      sha256: "abc",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      pages: [],
    });
    const src = new UploadSource(db, "c1");
    const { entries } = await collect(src as never);
    expect(entries).toEqual([{ key: "1", displayName: "Notice.pdf", locator: "abc", sizeBytes: 10, modifiedAt: "2026-01-01T00:00:00.000Z" }]);
    const opened = await src.open(entries[0]);
    expect(opened.path).toBe(path.join(dir, "uploads", "abc.pdf"));
    expect(src.id).toBe("upload:c1");
    db.close();
    delete process.env.UPLOADS_DIR;
  });
});

// Keep SourceFileError referenced for readers: every classified failure above is one.
void SourceFileError;
