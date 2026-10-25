import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldCase, loosen } from "../search/normalize";
import { prepareQuery } from "../search/query";
import { mulberry32 } from "./pipeline";
import { countMatches, librarySearch, type LibraryHit } from "./query";
import { splitLibraryTextId } from "./schema";
import { buildLibraryIndex, type FixtureDoc } from "./testing/libraryIndex";
import { toFtsPhrase } from "../search/query";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-libquery-"));
});

afterEach(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(docs: FixtureDoc[]) {
  buildLibraryIndex(dir, docs);
  db = new Database(path.join(dir, "library", "library.db"), { readonly: true });
}

const ok = (o: ReturnType<typeof librarySearch>) => {
  if (o.status !== "ok") throw new Error(`expected ok, got ${o.status}`);
  return o.result;
};

describe("librarySearch", () => {
  it("finds pages in document then page order, with path names, labels, OCR flags and snippets", () => {
    open([
      { key: "b/second.pdf", pages: [{ layer: "nothing here" }, { layer: "the Earnest Money clause", label: "ii" }] },
      { key: "a/first.pdf", pages: [{ layer: "", ocr: "earnest money from OCR only" }, { layer: "earnest money in text", ocr: "earnest money in ocr too" }] },
    ]);
    const r = ok(librarySearch(db, "earnest money", { mode: "exact" }));
    expect(r.hits.map((h) => [h.displayName, h.pageNo, h.pageLabel, h.matchedIn, h.ocrOnly])).toEqual([
      ["b/second.pdf", 2, "ii", ["layer"], false],
      ["a/first.pdf", 1, null, ["ocr"], true],
      ["a/first.pdf", 2, null, ["layer", "ocr"], false],
    ]);
    // Snippet from the text layer when both readings match.
    expect(r.hits[2].snippet.map((p) => p.text).join("")).toContain("earnest money in text");
    expect(r.counts).toEqual({ pages: 3, documents: 2, complete: true });
    expect(r.nextCursor).toBeNull();
    expect(r.looseCount).toBeNull();
  });

  it("pages by cursor: following nextCursor visits exactly the brute-force matches, in order, with no gaps or repeats", () => {
    const rng = mulberry32(11);
    const words = ["tender", "ocelot", "bank", "guarantee", "26-2080", "deposit", "notice"];
    const docs: FixtureDoc[] = Array.from({ length: 30 }, (_, d) => ({
      key: `folder/doc-${String(d).padStart(2, "0")}.pdf`,
      pages: Array.from({ length: 1 + Math.floor(rng() * 12) }, () => {
        const text = () => Array.from({ length: 8 }, () => words[Math.floor(rng() * words.length)]).join(" ");
        return rng() < 0.3 ? { layer: text(), ocr: text() } : { layer: text() };
      }),
    }));
    open(docs);

    for (const [q, mode] of [["ocelot", "exact"], ["26/2080", "loose"], ["bank guarantee", "exact"]] as const) {
      const seen: LibraryHit[] = [];
      let cursor = 0;
      let first = true;
      let total = 0;
      for (;;) {
        const r = ok(librarySearch(db, q, { mode, cursor, limit: 7 }));
        if (first) total = r.counts!.pages;
        else expect(r.counts).toBeNull();
        first = false;
        expect(r.hits.length).toBeLessThanOrEqual(7);
        seen.push(...r.hits);
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      // Brute force over every stored text.
      const prepared = prepareQuery(q, mode);
      const rows = db.prepare("SELECT id, body FROM texts ORDER BY id").all() as Array<{ id: number; body: string }>;
      const expected: string[] = [];
      for (const row of rows) {
        const f = foldCase(row.body);
        if (!(mode === "exact" ? f : loosen(f)).includes(prepared)) continue;
        const { docId, pageNo } = splitLibraryTextId(row.id);
        const k = `${docId}:${pageNo}`;
        if (expected[expected.length - 1] !== k) expected.push(k);
      }
      expect(seen.map((h) => `${h.docId}:${h.pageNo}`)).toEqual(expected);
      expect(total).toBe(expected.length);
      expect(expected.length).toBeGreaterThan(7);
    }
  });

  it("counts within a time budget: past it, the counts are partial and say so", () => {
    open(Array.from({ length: 20 }, (_, d) => ({ key: `d${d}.pdf`, pages: Array.from({ length: 200 }, () => ({ layer: "common word everywhere" })) })));
    const full = countMatches(db, toFtsPhrase("common"), "exact", 10_000);
    expect(full).toEqual({ pages: 4000, documents: 20, complete: true });
    const cut = countMatches(db, toFtsPhrase("common"), "exact", -1);
    expect(cut.complete).toBe(false);
    expect(cut.pages).toBeLessThan(4000);
    expect(cut.pages).toBeGreaterThan(0);
  });

  it("refuses queries under 3 characters (the index can't look them up; a full scan would be too slow at library scale)", () => {
    open([{ key: "a.pdf", pages: [{ layer: "a b c" }] }]);
    expect(librarySearch(db, "ab", { mode: "exact" })).toEqual({ status: "too-short", query: "ab" });
    expect(librarySearch(db, "€5", { mode: "exact" }).status).toBe("too-short");
    expect(librarySearch(db, "abc", { mode: "exact" }).status).toBe("ok");
  });

  it("offers the loose count when exact finds nothing", () => {
    open([{ key: "a.pdf", pages: [{ layer: "ref 26/2080 dated" }, { layer: "and 26 2080 again" }] }]);
    const r = ok(librarySearch(db, "26-2080", { mode: "exact" }));
    expect(r.hits).toEqual([]);
    expect(r.looseCount).toBe(2);
    const loose = ok(librarySearch(db, "26-2080", { mode: "loose" }));
    expect(loose.hits.map((h) => h.pageNo)).toEqual([1, 2]);
  });

  it("marks documents still being indexed", () => {
    open([{ key: "busy.pdf", pages: [{ layer: "partial ocelot" }], status: "indexing" }]);
    expect(ok(librarySearch(db, "ocelot", { mode: "exact" })).hits[0].stillIndexing).toBe(true);
  });

  it("treats FTS syntax as literal text", () => {
    open([{ key: "a.pdf", pages: [{ layer: 'say "AND" NEAR( it' }] }]);
    expect(ok(librarySearch(db, '"AND" NEAR(', { mode: "exact" })).hits).toHaveLength(1);
    expect(ok(librarySearch(db, "' OR 1=1 --", { mode: "exact" })).hits).toEqual([]);
  });
});
