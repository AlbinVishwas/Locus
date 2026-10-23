import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OcrCache } from "../../scripts/indexer/ocrCache";
import { openIndex } from "../../scripts/indexer/store";
import { SCHEMA_VERSION } from "@/lib/search/schema";

/**
 * Characterization (pinned at the pre-library tag): the session index and
 * the OCR cache, exactly as a fresh file comes out today. The library
 * feature must put its data in new files and new tables; this fails if
 * anything about the existing layout changes -- a column, an index, a
 * pragma, the schema version -- so that can't happen by accident.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-schema-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function schemaOf(file: string): Array<{ type: string; name: string; sql: string | null }> {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string | null }>;
  } finally {
    db.close();
  }
}

describe("characterization: session index schema", () => {
  it("is schema version 4", () => {
    expect(SCHEMA_VERSION).toBe(4);
    const db = openIndex(path.join(dir, "search.db"));
    expect(db.prepare("SELECT key, value FROM meta ORDER BY key").all()).toEqual([
      { key: "schema_version", value: "4" },
    ]);
    db.close();
  });

  it("creates exactly these tables, indexes and FTS tables", () => {
    const file = path.join(dir, "search.db");
    openIndex(file).close();
    const objects = schemaOf(file);
    // Names only first, so a failure reads as "this appeared / vanished".
    expect(objects.map((o) => `${o.type} ${o.name}`)).toEqual([
      "index documents_conversation",
      "index documents_expires",
      "index documents_sha256",
      "index documents_tender_filename",
      "index texts_page",
      "table documents",
      "table meta",
      "table pages",
      "table texts",
      "table texts_exact",
      "table texts_exact_config",
      "table texts_exact_data",
      "table texts_exact_docsize",
      "table texts_exact_idx",
      "table texts_loose",
      "table texts_loose_config",
      "table texts_loose_data",
      "table texts_loose_docsize",
      "table texts_loose_idx",
    ]);
    expect(objects).toMatchSnapshot();
  });

  it("opens with WAL, foreign keys and incremental auto-vacuum", () => {
    const db = openIndex(path.join(dir, "search.db"));
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2); // INCREMENTAL
    db.close();
  });

  it("refuses an index with a different schema version, with the rebuild hint", () => {
    const file = path.join(dir, "search.db");
    const db = openIndex(file);
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
    db.close();
    expect(() => openIndex(file)).toThrow(
      `Index at ${file} has schema version 3, this code writes 4. Rebuild it with: npm run index -- --force`
    );
  });
});

describe("characterization: OCR cache schema", () => {
  it("is one table keyed by (sha256, page, lang, dpi)", () => {
    const file = path.join(dir, "ocr-cache.db");
    new OcrCache(file).close();
    expect(schemaOf(file)).toMatchSnapshot();
  });
});
