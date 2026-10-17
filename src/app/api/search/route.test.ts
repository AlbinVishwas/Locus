import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, replaceDocument } from "../../../../scripts/indexer/store";
import type { SearchResult } from "@/lib/search/query";
import { POST } from "./route";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "search-route-"));
  const file = path.join(dir, "search.db");
  const db = openIndex(file);
  replaceDocument(db, {
    filename: "notice.pdf",
    sha256: "x",
    sizeBytes: 1,
    pageCount: 2,
    ocrLang: "eng",
    settings: "test",
    error: null,
    pages: [
      { pageNo: 1, pageLabel: "i", source: "text", ocrReason: null, imageCoverage: 0, layerText: 'Tender No. 26-2080 says "hello" AND NEAR(x)', ocrText: null, error: null },
      { pageNo: 2, pageLabel: null, source: "ocr", ocrReason: "no-text-layer", imageCoverage: 1, layerText: "", ocrText: "scanned QUOKKA page", error: null },
    ],
  });
  db.close();
  process.env.SEARCH_INDEX_PATH = file;
});

afterAll(() => {
  delete process.env.SEARCH_INDEX_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

function post(body: unknown, init: RequestInit = {}) {
  return POST(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    })
  );
}

describe("POST /api/search", () => {
  it("returns hits with page numbers, labels, and the OCR flag", async () => {
    const res = await post({ query: "quokka" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as SearchResult;
    expect(json.totalPages).toBe(1);
    expect(json.hits[0]).toMatchObject({ filename: "notice.pdf", pageNo: 2, ocrOnly: true });
  });

  it.each([
    ['"hello"', 1],
    ['"', 1],
    ["AND NEAR(x)", 1],
    ["NEAR(", 1],
    ["notice.pdf* OR 1", 0],
    ["'; DROP TABLE pages; --", 0],
    ["{search}: tender", 0],
  ])("treats %j as literal text (expects %i page)", async (query, expected) => {
    const res = await post({ query });
    expect(res.status).toBe(200);
    expect(((await res.json()) as SearchResult).totalPages).toBe(expected);
  });

  it.each([
    ["not json", "Invalid JSON body"],
    [{ query: 5 }, "`query` must be a string"],
    [{ query: "" }, "must contain some text"],
    [{ query: "a".repeat(501) }, "limited to 500"],
    [{ query: "a", mode: "fuzzy" }, "`mode`"],
    [{ query: "a", limit: 10_000 }, "`limit`"],
    [[{ query: "a" }], "JSON object"],
  ])("rejects %j with 400", async (body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(message);
  });

  it("refuses an oversized body before parsing it", async () => {
    const res = await post({ query: "a", padding: "x".repeat(20_000) });
    expect(res.status).toBe(413);
  });

  it("says how to fix a missing index instead of failing obscurely", async () => {
    const saved = process.env.SEARCH_INDEX_PATH;
    process.env.SEARCH_INDEX_PATH = path.join(dir, "nope.db");
    const res = await post({ query: "tender" });
    process.env.SEARCH_INDEX_PATH = saved;
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm run index");
  });
});
