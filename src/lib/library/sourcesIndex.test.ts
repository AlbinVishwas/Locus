import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import { librarySearch } from "./query";
import {
  docIdRange,
  libraryTextId,
  MAX_SOURCE_ORDINAL,
  ordinalOfDocId,
  sourceTextIdRange,
  splitLibraryTextId,
} from "./schema";
import {
  beginDocument,
  dropSource,
  libraryCounts,
  listSources,
  markDocumentReady,
  openLibraryDb,
  registerSource,
  removeSourceContent,
  writePages,
} from "./store";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-sources-index-"));
});

afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = (pageNo: number, layer: string): ExtractedPage => ({
  pageNo,
  pageLabel: null,
  source: "text",
  ocrReason: null,
  imageCoverage: 0,
  layerText: layer,
  ocrText: null,
  error: null,
});

function addDoc(sourceId: string, key: string, pages: string[]): number {
  const id = beginDocument(db, {
    sourceId,
    key,
    displayName: key,
    sizeBytes: 1,
    modifiedAt: null,
    sha256: `${sourceId}/${key}`,
    pageCount: pages.length,
    ocrLang: "eng",
    settings: "x",
    encryption: null,
    scanId: 1,
  });
  writePages(db, id, pages.map((t, i) => page(i + 1, t)));
  markDocumentReady(db, id);
  return id;
}

const search = (q: string, sourceOrdinal?: number, mode: "exact" | "loose" = "exact") => {
  const o = librarySearch(db, q, { mode, sourceOrdinal });
  if (o.status !== "ok") throw new Error(o.status);
  return o.result;
};

describe("document-id ranges", () => {
  it("each ordinal owns 2^24 documents; text ids stay exact below 2^53 even for the very last page of the very last source", () => {
    expect(docIdRange(0)).toEqual([0, 16_777_215]);
    expect(docIdRange(3)).toEqual([3 * 16_777_216, 4 * 16_777_216 - 1]);
    const lastDoc = docIdRange(MAX_SOURCE_ORDINAL)[1];
    expect(lastDoc).toBe(2 ** 32 - 1);
    const id = libraryTextId(lastDoc, 2 ** 20 - 1, "ocr");
    expect(id).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER); // fits to the very last bit
    expect(splitLibraryTextId(id)).toEqual({ docId: lastDoc, pageNo: 2 ** 20 - 1, kind: "ocr" });
    expect(ordinalOfDocId(lastDoc)).toBe(MAX_SOURCE_ORDINAL);
  });

  it("a source's text-id range holds exactly its documents' text ids", () => {
    const [lo, hi] = sourceTextIdRange(2);
    expect(splitLibraryTextId(lo)).toEqual({ docId: docIdRange(2)[0], pageNo: 0, kind: "layer" });
    expect(splitLibraryTextId(hi).docId).toBe(docIdRange(2)[1]);
    expect(libraryTextId(docIdRange(1)[1], 100, "ocr")).toBeLessThan(lo);
    expect(libraryTextId(docIdRange(3)[0], 0, "layer")).toBeGreaterThan(hi);
  });
});

describe("sources, ordinals and per-source search", () => {
  it("registers sources with ascending, never-reused ordinals, and lists them", () => {
    db = openLibraryDb(path.join(dir, "library.db"));
    expect(registerSource(db, { id: "a", kind: "folder", label: "folder /x/a", name: "Tenders" })).toBe(1);
    expect(registerSource(db, { id: "b", kind: "database", label: "database x", name: "Records" })).toBe(2);
    // Registering again keeps the ordinal and refreshes the name.
    expect(registerSource(db, { id: "a", kind: "folder", label: "folder /x/a", name: "Tenders 2026" })).toBe(1);
    expect(listSources(db)).toEqual([
      { id: "a", kind: "folder", name: "Tenders 2026", ordinal: 1 },
      { id: "b", kind: "database", name: "Records", ordinal: 2 },
    ]);
    dropSource(db, "b");
    // The freed ordinal is NOT handed to a new source.
    expect(registerSource(db, { id: "c", kind: "folder", label: "l", name: "C" })).toBe(3);
  });

  it("a library can have at most 255 sources over its lifetime", () => {
    db = openLibraryDb(path.join(dir, "library.db"));
    for (let i = 1; i <= MAX_SOURCE_ORDINAL; i++) registerSource(db, { id: `s${i}`, kind: "folder", label: "l" });
    expect(() => registerSource(db, { id: "one-too-many", kind: "folder", label: "l" })).toThrow(/at most 255 sources/);
  });

  it("documents get ids inside their source's range; the search can be limited to one source, and every hit names its source", () => {
    db = openLibraryDb(path.join(dir, "library.db"));
    registerSource(db, { id: "a", kind: "folder", label: "folder /x/a", name: "Tenders" });
    registerSource(db, { id: "b", kind: "database", label: "database", name: "Records" });
    const a1 = addDoc("a", "a/one.pdf", ["the ocelot clause", "nothing"]);
    const b1 = addDoc("b", "db:7 · two.pdf", ["another ocelot here"]);
    const a2 = addDoc("a", "a/three.pdf", ["ocelot again"]);
    expect([a1, a2]).toEqual([docIdRange(1)[0] + 1, docIdRange(1)[0] + 2]);
    expect(b1).toBe(docIdRange(2)[0] + 1);

    const all = search("ocelot");
    expect(all.hits.map((h) => [h.sourceName, h.sourceKind, h.displayName])).toEqual([
      ["Tenders", "folder", "a/one.pdf"],
      ["Tenders", "folder", "a/three.pdf"],
      ["Records", "database", "db:7 · two.pdf"],
    ]);
    expect(all.counts).toEqual({ pages: 3, documents: 3, complete: true });

    const onlyA = search("ocelot", 1);
    expect(onlyA.hits.map((h) => h.displayName)).toEqual(["a/one.pdf", "a/three.pdf"]);
    expect(onlyA.counts).toEqual({ pages: 2, documents: 2, complete: true });
    const onlyB = search("ocelot", 2);
    expect(onlyB.hits.map((h) => h.displayName)).toEqual(["db:7 · two.pdf"]);
    expect(search("ocelot", 9).hits).toEqual([]);
  });

  it("a per-source search equals a brute-force scan of just that source, across windows", () => {
    db = openLibraryDb(path.join(dir, "library.db"));
    for (const [id, name] of [["a", "A"], ["b", "B"], ["c", "C"]]) registerSource(db, { id, kind: "folder", label: "l", name });
    for (let d = 0; d < 12; d++) {
      for (const id of ["a", "b", "c"]) addDoc(id, `${id}/${d}.pdf`, Array.from({ length: 1 + (d % 4) }, (_, p) => (p % 2 === 0 ? `ocelot in ${id} doc ${d}` : `other words ${id}`)));
    }
    for (const [ordinal, id] of [[1, "a"], [2, "b"], [3, "c"]] as const) {
      const expected = (db
        .prepare("SELECT d.display_name || '#' || p.page_no FROM pages p JOIN documents d ON d.id = p.doc_id WHERE d.source_id = ? AND p.page_no % 2 = 1 ORDER BY d.id, p.page_no")
        .pluck()
        .all(id) as string[]);
      const seen: string[] = [];
      let cursor = 0;
      for (;;) {
        const o = librarySearch(db, "ocelot", { mode: "exact", sourceOrdinal: ordinal, cursor, limit: 5 });
        if (o.status !== "ok") throw new Error("x");
        seen.push(...o.result.hits.map((h) => `${h.displayName}#${h.pageNo}`));
        if (o.result.nextCursor === null) break;
        cursor = o.result.nextCursor;
      }
      expect(seen).toEqual(expected);
      expect(expected.length).toBeGreaterThan(5);
    }
  });

  it("removing a source deletes its index entries only: the other source is untouched and the full-text tables stay consistent", () => {
    db = openLibraryDb(path.join(dir, "library.db"));
    registerSource(db, { id: "a", kind: "folder", label: "l", name: "A" });
    registerSource(db, { id: "b", kind: "folder", label: "l", name: "B" });
    for (let i = 0; i < 7; i++) addDoc("a", `a${i}.pdf`, ["ocelot a", "more a"]);
    for (let i = 0; i < 3; i++) addDoc("b", `b${i}.pdf`, ["ocelot b"]);
    const before = search("ocelot", 2).hits.map((h) => `${h.displayName}#${h.pageNo}`);

    let left = removeSourceContent(db, "a", 3);
    expect(left).toBe(4);
    left = removeSourceContent(db, "a", 3);
    left = removeSourceContent(db, "a", 3);
    expect(left).toBe(0);
    dropSource(db, "a");

    expect(search("ocelot").hits.every((h) => h.sourceName === "B")).toBe(true);
    expect(search("ocelot", 2).hits.map((h) => `${h.displayName}#${h.pageNo}`)).toEqual(before);
    expect(search("ocelot", 1).hits).toEqual([]);
    const count = (sql: string) => Number(db.prepare(sql).pluck().get());
    expect(count("SELECT count(*) FROM texts")).toBe(3);
    expect(count("SELECT count(*) FROM texts_exact_docsize")).toBe(3);
    expect(count("SELECT count(*) FROM texts_loose_docsize")).toBe(3);
    expect(count("SELECT count(*) FROM pages")).toBe(3);
    expect(libraryCounts(db).documents).toBe(3);
    expect(listSources(db).map((s) => s.id)).toEqual(["b"]);
  });
});

describe("migration from schema v1", () => {
  it("adds ordinal and name, keeps every document id and every search result, files the old sources under ordinal 0", () => {
    const file = path.join(dir, "library.db");
    db = openLibraryDb(file);
    // Documents indexed by an unregistered source land in ordinal 0's range -- exactly what v1 did.
    const id = addDoc("legacy", "old/one.pdf", ["the legacy ocelot page"]);
    expect(id).toBe(1);
    db.prepare("INSERT INTO sources (id, kind, label, added_at) VALUES ('legacy', 'folder', 'folder /old', 'x')").run();
    // Turn this into a v1 file: older source table, version 1, no ordinal counter.
    db.exec("ALTER TABLE sources DROP COLUMN ordinal; ALTER TABLE sources DROP COLUMN name;");
    db.exec("UPDATE meta SET value = '1' WHERE key = 'library_schema_version'; DELETE FROM meta WHERE key = 'next_ordinal';");
    db.close();

    db = openLibraryDb(file);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'library_schema_version'").pluck().get()).toBe("2");
    expect(listSources(db)).toEqual([{ id: "legacy", kind: "folder", name: "folder", ordinal: 0 }]);
    const r = search("legacy ocelot");
    expect(r.hits.map((h) => [h.docId, h.displayName, h.sourceName])).toEqual([[1, "old/one.pdf", "folder"]]);
    expect(search("legacy ocelot", 0).hits).toHaveLength(1);
    // New sources continue from ordinal 1; the old data didn't move.
    expect(registerSource(db, { id: "new", kind: "folder", label: "l", name: "New" })).toBe(1);
    const n = addDoc("new", "new/two.pdf", ["new ocelot"]);
    expect(n).toBe(docIdRange(1)[0] + 1);
    expect(search("ocelot").hits.map((h) => h.displayName)).toEqual(["old/one.pdf", "new/two.pdf"]);
    // Migrating is idempotent.
    db.close();
    db = openLibraryDb(file);
    expect(listSources(db).map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it("refuses a version it doesn't know", () => {
    const file = path.join(dir, "library.db");
    db = openLibraryDb(file);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'library_schema_version'").run();
    db.close();
    expect(() => openLibraryDb(file)).toThrow(/schema version 99/);
  });
});
