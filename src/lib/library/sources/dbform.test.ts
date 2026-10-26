import { describe, expect, it } from "vitest";
import {
  buildQuery,
  buildUrl,
  checkColumns,
  checkHost,
  checkIdentifier,
  checkPort,
  FormError,
  parseConnectionString,
  quoteIdent,
  splitTable,
} from "./db/form";
import { chunkSql, columnsSql, listSql } from "./db/sql";
import { parseDbUrl, redactUrl } from "./db/sql";

const cols = { id: "id", filename: "name", modified: "updated_at", content: "pdf" };

describe("identifiers: what's typed can never become SQL", () => {
  it("accepts ordinary names", () => {
    for (const ok of ["documents", "_private", "Table1", "pdf_bytes", "a$b", "x".repeat(63)]) expect(checkIdentifier("x", ok)).toBe(ok);
    expect(checkIdentifier("x", "  padded  ")).toBe("padded");
  });

  it("refuses every injection and odd-name attempt, with a message that names the field", () => {
    for (const bad of [
      'docs"; DROP TABLE users; --',
      "docs; DELETE FROM docs",
      "docs--",
      "docs/*x*/",
      "a b",
      "a.b",
      "a-b",
      "1abc",
      "",
      "   ",
      "naïve",
      "x".repeat(64),
      "docs\nDROP",
      "docs`",
      "docs'",
      "docs)",
      "*",
      "id, password",
      "id) UNION SELECT secret FROM keys --",
    ]) {
      expect(() => checkIdentifier("table name", bad), JSON.stringify(bad)).toThrow(FormError);
    }
    expect(() => checkIdentifier("ID column", "a b")).toThrow(/ID column/);
    expect(() => checkIdentifier("x", null)).toThrow(FormError);
    expect(() => checkIdentifier("x", 42)).toThrow(FormError);
  });

  it("table can be table or schema.table, nothing more", () => {
    expect(splitTable("documents")).toEqual({ table: "documents" });
    expect(splitTable("public.documents")).toEqual({ schema: "public", table: "documents" });
    expect(() => splitTable("a.b.c")).toThrow(FormError);
    expect(() => splitTable("public.docs; drop")).toThrow(FormError);
    expect(() => splitTable("")).toThrow(FormError);
  });

  it("all four column names are checked", () => {
    expect(checkColumns(cols)).toEqual(cols);
    expect(() => checkColumns({ ...cols, content: "pdf; --" })).toThrow(/file content column/);
    expect(() => checkColumns({ ...cols, modified: undefined })).toThrow(/modified time column/);
  });
});

describe("generated query", () => {
  const base = { schema: undefined, table: "documents", columns: cols, content: "file_bytes" as const };

  it("quotes identifiers per dialect and aliases the columns Locus needs", () => {
    expect(buildQuery({ ...base, dialect: "postgres" })).toBe(
      'SELECT "id" AS id, "name" AS filename, "updated_at" AS modified_at, "pdf" AS file_bytes FROM "documents"'
    );
    expect(buildQuery({ ...base, dialect: "mysql", content: "file_path", schema: "records" })).toBe(
      "SELECT `id` AS id, `name` AS filename, `updated_at` AS modified_at, `pdf` AS file_path FROM `records`.`documents`"
    );
    expect(buildQuery({ ...base, dialect: "sqlite" })).toContain('FROM "documents"');
    expect(quoteIdent("mysql", "a")).toBe("`a`");
    expect(quoteIdent("postgres", "a")).toBe('"a"');
  });

  it("refuses to generate anything from a bad identifier, even if one slipped past the form", () => {
    expect(() => buildQuery({ ...base, dialect: "postgres", table: 'x"; DROP TABLE y; --' })).toThrow(FormError);
    expect(() => buildQuery({ ...base, dialect: "postgres", columns: { ...cols, id: "id, secret" } })).toThrow(FormError);
  });

  it("wrapped by sql.ts it is still one SELECT with every value bound", () => {
    const q = buildQuery({ ...base, dialect: "postgres" });
    expect(columnsSql(q)).toBe(`SELECT * FROM (${q}) AS locus_q WHERE 1 = 0`);
    expect(listSql("postgres", q, "file_bytes", 500, true)).toContain("WHERE locus_q.id > $1");
    expect(chunkSql("mysql", q)).toContain("SUBSTRING(locus_q.file_bytes, ?, ?)");
  });
});

describe("connection", () => {
  it("builds server URLs with the password encoded, in memory only", () => {
    const cfg = { dialect: "postgres" as const, host: "db.internal", port: 5432, database: "records", user: "reader" };
    expect(buildUrl(cfg, "p@ss/w:rd#1")).toBe("postgres://reader:p%40ss%2Fw%3Ard%231@db.internal:5432/records");
    expect(buildUrl(cfg, null)).toBe("postgres://reader@db.internal:5432/records");
    expect(buildUrl({ ...cfg, dialect: "mysql", port: undefined }, "x")).toBe("mysql://reader:x@db.internal:3306/records");
    expect(buildUrl({ dialect: "postgres", host: "::1", port: 5432, database: "d", user: "u" }, null)).toBe("postgres://u@[::1]:5432/d");
    // The same URL the Phase 1 source understands, and redacts.
    expect(parseDbUrl(buildUrl(cfg, "pw")).dialect).toBe("postgres");
    expect(redactUrl(buildUrl(cfg, "pw"))).toBe("postgres://reader:***@db.internal:5432/records");
  });

  it("sqlite takes a file", () => {
    expect(buildUrl({ dialect: "sqlite", file: "/Volumes/A/docs.db" })).toBe("sqlite:///Volumes/A/docs.db");
    expect(parseDbUrl("sqlite:///Volumes/A/docs.db")).toEqual({ dialect: "sqlite", file: "/Volumes/A/docs.db" });
    expect(() => buildUrl({ dialect: "sqlite" })).toThrow(/database file/);
  });

  it("refuses link-local and cloud-metadata hosts; private networks and localhost are fine", () => {
    for (const bad of ["169.254.169.254", "169.254.0.1", "metadata.google.internal", "fe80::1", "[fe80::1]", "fd00:ec2::254"]) {
      expect(() => checkHost(bad), bad).toThrow(/reserved/);
    }
    for (const ok of ["db.internal", "10.0.0.5", "192.168.1.20", "localhost", "127.0.0.1", "my-db_01.example.com", "[::1]"]) expect(checkHost(ok)).toBe(ok);
    for (const bad of ["", "a b", "db;rm -rf", "db/path", "x".repeat(300), "-bad", "bad-"]) expect(() => checkHost(bad), bad).toThrow(FormError);
  });

  it("ports", () => {
    expect(checkPort(undefined, 5432)).toBe(5432);
    expect(checkPort("", 3306)).toBe(3306);
    expect(checkPort("6543", 5432)).toBe(6543);
    for (const bad of [0, 70000, 1.5, "abc", -1]) expect(() => checkPort(bad, 5432)).toThrow(/port/);
  });

  it("splits a pasted connection string into fields, with the password separate", () => {
    expect(parseConnectionString("postgres://reader:s%40cret@db.internal:6543/records?sslmode=require")).toEqual({
      dialect: "postgres",
      host: "db.internal",
      port: 6543,
      database: "records",
      user: "reader",
      password: "s@cret",
    });
    expect(parseConnectionString("mysql://u@host/db")).toMatchObject({ dialect: "mysql", port: 3306, password: null });
    expect(parseConnectionString("postgresql://u:p@h/d").dialect).toBe("postgres");
  });

  it("refuses what it can't use, without echoing a password in the message", () => {
    const attempts = ["mongodb://u:hunter2@h/db", "not a url", "postgres://u:hunter2@169.254.169.254/db", "ftp://u:hunter2@h/x"];
    for (const a of attempts) {
      let message = "";
      try {
        parseConnectionString(a);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, a).not.toBe("");
      expect(message).not.toContain("hunter2");
    }
  });
});
