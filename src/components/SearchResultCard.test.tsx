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
});
