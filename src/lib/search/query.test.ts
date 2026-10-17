import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import {
  compare,
  loadCorpus,
  sampleQueries,
  seededRandom,
  viaIndex,
  type Corpus,
} from "../../../scripts/indexer/oracle";
import { openIndex, replaceDocument, type ExtractedPage } from "../../../scripts/indexer/store";
import { search, toFtsPhrase } from "./query";

/**
 * Query behaviour against a small synthetic index written through the real
 * indexer code path (replaceDocument). PDF extraction itself is covered by
 * scripts/indexer/pipeline.test.ts; here the input text is controlled
 * exactly, so every edge case is deliberate.
 */

function page(pageNo: number, layerText: string, ocrText: string | null = null): ExtractedPage {
  return {
    pageNo,
    pageLabel: null,
    source: ocrText === null ? "text" : layerText.trim() ? "text+ocr" : "ocr",
    ocrReason: ocrText === null ? null : "test",
    imageCoverage: 0,
    layerText,
    ocrText,
    error: null,
  };
}

function addDoc(db: Database.Database, filename: string, pages: ExtractedPage[]) {
  replaceDocument(db, {
    filename,
    sha256: filename,
    sizeBytes: 1,
    pageCount: pages.length,
    ocrLang: "eng",
    settings: "test",
    error: null,
    pages,
  });
}

// Text full of things that could confuse a full-text engine: FTS5 operators,
// quotes, brackets, punctuation-only tokens, non-Latin script, accents.
const TRICKY_WORDS = [
  "AND", "OR", "NOT", "NEAR", "NEAR(a b)", '"quoted"', "col:value", "*", "^start",
  "(paren)", "{brace}", "a'b", "26-2080", "26/2080", "26.2080", "Rs.", "₹5,00,000",
  "निविदा", "café", "naïve", "ISO-9001:2015", "e-mail", "--", "...", "_", "%", "\\", "x",
];
const VOCAB = [
  "tender", "bidder", "earnest", "money", "deposit", "clause", "schedule", "security",
  "performance", "guarantee", "submission", "technical", "financial", "evaluation",
  "eligibility", "railway", "drawing", "rate", "quantity", "completion", "penalty",
];

function syntheticText(rand: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    const pool = rand() < 0.15 ? TRICKY_WORDS : VOCAB;
    out.push(pool[Math.floor(rand() * pool.length)]);
    if (rand() < 0.1) out.push("\n");
  }
  return out.join(" ");
}

let db: Database.Database;
let corpus: Corpus;

beforeAll(() => {
  db = openIndex(":memory:");

  addDoc(db, "alpha-notice.pdf", [
    page(1, "The bidder shall pay the zanzibar mongoose\ndeposit before the due date."),
    page(2, "Tender No. 26-2080 dated 01.09.2026"),
    page(3, "Reference 26/2080 appears here"),
    page(4, "", "QUOKKA appears only in the scanned image"),
    page(5, "Header typed on the page", "PLATYPUS is in the scanned attachment"),
    page(6, ""),
  ]);
  addDoc(db, "beta-schedule.pdf", [
    page(1, "Rs. 5 lakh is the EMD"),
    page(2, "Nothing relevant on this page"),
  ]);
  addDoc(db, "Tender_No_26-2080-annex.pdf", [page(1, "A schedule page with no tender number inside")]);

  const rand = seededRandom(20261017);
  for (let d = 0; d < 6; d++) {
    addDoc(
      db,
      `synthetic-${d}.pdf`,
      Array.from({ length: 40 }, (_, i) =>
        page(i + 1, syntheticText(rand, 120), rand() < 0.2 ? syntheticText(rand, 60) : null)
      )
    );
  }

  corpus = loadCorpus(db);
});

const hitKeys = (query: string, mode: "exact" | "loose" = "exact") =>
  [...viaIndex(db, query, mode).pages].sort();

describe("search: required edge cases", () => {
  it("finds a phrase that crosses a line break in the PDF text", () => {
    expect(hitKeys("zanzibar mongoose deposit")).toEqual(["alpha-notice.pdf#1"]);
  });

  it("finds a query that exists only on an OCR page, and flags it", () => {
    const result = search(db, "quokka", { mode: "exact", offset: 0, limit: 10 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      filename: "alpha-notice.pdf",
      pageNo: 4,
      source: "ocr",
      matchedIn: ["ocr"],
      ocrOnly: true,
    });
  });

  it("finds a query only in the OCR reading of a mixed page", () => {
    const result = search(db, "platypus", { mode: "exact", offset: 0, limit: 10 });
    expect(result.hits[0]).toMatchObject({ pageNo: 5, source: "text+ocr", ocrOnly: true });
  });

  it("keeps punctuation exact by default: 26-2080 does not match 26/2080", () => {
    const dash = hitKeys("26-2080");
    expect(dash).toContain("alpha-notice.pdf#2");
    expect(dash).not.toContain("alpha-notice.pdf#3");
    expect(hitKeys("26/2080")).toContain("alpha-notice.pdf#3");
    expect(hitKeys("26/2080")).not.toContain("alpha-notice.pdf#2");
  });

  it("matches punctuation variants in loose mode", () => {
    const loose = hitKeys("26-2080", "loose");
    expect(loose).toEqual(expect.arrayContaining(["alpha-notice.pdf#2", "alpha-notice.pdf#3"]));
  });

  it("answers a query under 3 characters with a full scan, completely", () => {
    const result = search(db, "Rs", { mode: "exact", offset: 0, limit: 1000 });
    expect(result.usedFullScan).toBe(true);
    expect(result.hits.map((h) => `${h.filename}#${h.pageNo}`)).toContain("beta-schedule.pdf#1");
    expect(compare(db, corpus, "Rs", "exact")).toBeNull();
    expect(compare(db, corpus, "x", "exact")).toBeNull();
  });

  it("reports a filename-only match, flagged as such", () => {
    const result = search(db, "annex", { mode: "exact", offset: 0, limit: 10 });
    const doc = result.documents.find((d) => d.filename === "Tender_No_26-2080-annex.pdf");
    expect(doc).toEqual(expect.objectContaining({ filenameMatch: true, hitCount: 0 }));
    expect(result.totalPages).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(hitKeys("EARNEST money")).toEqual(hitKeys("earnest MONEY"));
  });

  it("highlights exactly the matched characters, in their original case", () => {
    const [hit] = search(db, "ZANZIBAR MONGOOSE", { mode: "exact", offset: 0, limit: 1 }).hits;
    expect(hit.snippet.filter((p) => p.hit).map((p) => p.text)).toEqual(["zanzibar mongoose"]);
  });

  it("highlights the original punctuation in loose mode", () => {
    const result = search(db, "26 2080", { mode: "loose", offset: 0, limit: 10 });
    const marked = result.hits.flatMap((h) => h.snippet.filter((p) => p.hit).map((p) => p.text));
    expect(marked).toEqual(expect.arrayContaining(["26-2080", "26/2080"]));
  });
});

describe("search: hostile and odd input is treated as plain text", () => {
  const hostile = [
    '"', '""', '"""', 'a"b', "AND", "OR", "NOT", "NEAR", "NEAR(a b)", "a AND b", "a OR b",
    "tender NOT bidder", "*", "tend*", "^start", "col:value", "search:tender", "{search}: x",
    "(", ")", "()", "{", "}", "-", "--", "+", ":", "'", "' OR 1=1 --", "'; DROP TABLE pages; --",
    "\\", "%", "_", "%_%", "\u0000", "\u0000tender", "tender\u0000", "😀", "निविदा", "café",
    "x".repeat(500), "tender ".repeat(70),
  ];

  it.each(hostile)("matches brute force for %j in both modes, without throwing", (query) => {
    expect(compare(db, corpus, query, "exact")).toBeNull();
    expect(compare(db, corpus, query, "loose")).toBeNull();
  });

  it("escapes quotes by doubling them inside one phrase", () => {
    expect(toFtsPhrase('say "hi"')).toBe('"say ""hi"""');
  });

  it("finds operator words as literal text", () => {
    expect(hitKeys("NEAR(a b)").length).toBeGreaterThan(0);
    expect(compare(db, corpus, "NEAR(a b)", "exact")).toBeNull();
  });

  it("leaves the index intact after an injection-shaped query", () => {
    search(db, "'; DROP TABLE pages; --", { mode: "exact", offset: 0, limit: 10 });
    expect(db.prepare("SELECT count(*) FROM pages").pluck().get()).toBeGreaterThan(0);
  });
});

describe("search: brute-force ground truth", () => {
  it("agrees exactly with a naive scan on 600 sampled queries per mode", () => {
    const queries = sampleQueries(corpus, 600, 7);
    const disagreements = [
      ...queries.map((q) => compare(db, corpus, q, "exact")),
      ...queries.map((q) => compare(db, corpus, q, "loose")),
    ].filter(Boolean);
    expect(disagreements).toEqual([]);
  });

  it("pages through every hit without skipping or repeating one", () => {
    const all = search(db, "tender", { mode: "exact", offset: 0, limit: 100_000 });
    const paged: string[] = [];
    for (let offset = 0; ; offset += 7) {
      const page = search(db, "tender", { mode: "exact", offset, limit: 7 });
      paged.push(...page.hits.map((h) => `${h.filename}#${h.pageNo}`));
      if (!page.hasMore) break;
    }
    expect(paged).toEqual(all.hits.map((h) => `${h.filename}#${h.pageNo}`));
    expect(paged.length).toBe(all.totalPages);
  });

  it("counts each page once even when both readings match", () => {
    addDoc(db, "both.pdf", [page(1, "duplicate marker zebra", "duplicate marker zebra")]);
    const result = search(db, "marker zebra", { mode: "exact", offset: 0, limit: 10 });
    expect(result.totalPages).toBe(1);
    expect(result.hits[0].matchedIn).toEqual(["layer", "ocr"]);
    expect(result.hits[0].ocrOnly).toBe(false);
  });
});
