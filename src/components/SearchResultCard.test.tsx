import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SearchResult } from "@/lib/search/query";
import SearchResultCard from "./SearchResultCard";

/** Static render, same approach as Markdown.test.tsx: checks what actually
 * reaches the screen, not the component's internals. */

function baseResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    query: "earnest money",
    mode: "exact",
    prepared: "earnest money",
    usedFullScan: false,
    totalPages: 0,
    totalDocuments: 0,
    documents: [],
    hits: [],
    offset: 0,
    limit: 50,
    hasMore: false,
    tookMs: 1.2,
    ...overrides,
  };
}

describe("SearchResultCard", () => {
  it("shows a quiet one-line message when nothing matches, with no card chrome", () => {
    const html = renderToStaticMarkup(<SearchResultCard result={baseResult()} />);
    expect(html).toContain("No page in this conversation");
    expect(html).toContain("earnest money");
    // No results card border/background around a "nothing found" message.
    expect(html).not.toContain("rounded-xl border");
  });

  it("offers the loose-mode switch only when a loose alternative actually has hits", () => {
    const loose = baseResult({
      mode: "loose",
      totalPages: 2,
      totalDocuments: 1,
      hits: [
        {
          docId: 1,
          filename: "notice.pdf",
          pageNo: 3,
          pageLabel: null,
          source: "text",
          matchedIn: ["layer"],
          ocrOnly: false,
          snippet: [{ text: "26 2080 appears here", hit: true }],
        },
      ],
    });
    const html = renderToStaticMarkup(
      <SearchResultCard result={baseResult()} looseAlternative={loose} />
    );
    expect(html).toContain("2 pages match");
    expect(html).toContain("without exact punctuation");
  });

  it("never offers the loose switch when there's nothing to switch to", () => {
    const html = renderToStaticMarkup(<SearchResultCard result={baseResult()} looseAlternative={null} />);
    expect(html).not.toContain("without exact punctuation");
  });

  it("renders hits grouped by document, with page numbers, a highlighted snippet, and an OCR badge where it applies", () => {
    const result = baseResult({
      totalPages: 2,
      totalDocuments: 1,
      hits: [
        {
          docId: 1,
          filename: "tender.pdf",
          pageNo: 4,
          pageLabel: "iv",
          source: "text",
          matchedIn: ["layer"],
          ocrOnly: false,
          snippet: [{ text: "the ", hit: false }, { text: "earnest money", hit: true }, { text: " deposit", hit: false }],
        },
        {
          docId: 1,
          filename: "tender.pdf",
          pageNo: 9,
          pageLabel: null,
          source: "ocr",
          matchedIn: ["ocr"],
          ocrOnly: true,
          snippet: [{ text: "earnest money", hit: true }],
        },
      ],
    });
    const html = renderToStaticMarkup(<SearchResultCard result={result} />);
    expect(html).toContain("tender.pdf");
    expect(html).toContain("Page 4");
    expect(html).toContain("printed as iv");
    expect(html).toContain("Page 9");
    expect(html).toContain("OCR");
    expect(html).toMatch(/<mark[^>]*>earnest money<\/mark>/);
  });

  it("flags a filename-only match separately from page hits", () => {
    const result = baseResult({
      totalPages: 0,
      totalDocuments: 0,
      documents: [{ docId: 2, filename: "earnest-money-notice.pdf", hitCount: 0, filenameMatch: true }],
    });
    const html = renderToStaticMarkup(<SearchResultCard result={result} />);
    expect(html).toContain("earnest-money-notice.pdf");
    expect(html).toContain("matches by filename only");
  });
  it("lists documents whose matches aren't loaded yet, and offers the next window", () => {
    const hit = (pageNo: number) => ({
      docId: 1,
      filename: "big.pdf",
      pageNo,
      pageLabel: null,
      source: "text" as const,
      matchedIn: ["layer" as const],
      ocrOnly: false,
      snippet: [{ text: "cat", hit: true }],
    });
    const result = baseResult({
      totalPages: 75,
      totalDocuments: 2,
      documents: [
        { docId: 1, filename: "big.pdf", hitCount: 60, filenameMatch: false },
        { docId: 2, filename: "small.pdf", hitCount: 15, filenameMatch: false },
      ],
      hits: Array.from({ length: 50 }, (_, i) => hit(i + 1)),
      hasMore: true,
    });
    const html = renderToStaticMarkup(<SearchResultCard result={result} conversationId="c1" searchOnly />);
    // All 50 loaded hits render, not a per-document preview.
    expect(html).toContain("Page 50");
    expect(html).toContain("50 of 60 pages");
    expect(html).toContain("small.pdf");
    expect(html).toContain("15 pages · not loaded yet");
    expect(html).toContain("Show the remaining 25 pages");
  });

  it("says how much is shown when it can't load more (no session id)", () => {
    const result = baseResult({
      totalPages: 75,
      totalDocuments: 1,
      documents: [{ docId: 1, filename: "big.pdf", hitCount: 75, filenameMatch: false }],
      hits: [
        {
          docId: 1,
          filename: "big.pdf",
          pageNo: 1,
          pageLabel: null,
          source: "text",
          matchedIn: ["layer"],
          ocrOnly: false,
          snippet: [{ text: "cat", hit: true }],
        },
      ],
      hasMore: true,
    });
    const html = renderToStaticMarkup(<SearchResultCard result={result} />);
    expect(html).toContain("Showing 1 of 75 pages");
    expect(html).not.toContain("Show the remaining");
  });
});
