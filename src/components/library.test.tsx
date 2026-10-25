import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibrarySearchResult } from "@/lib/library/query";
import type { DisplayMessage } from "@/lib/types";
import { FeaturesProvider } from "./FeaturesProvider";
import LibraryBar, { statusText } from "./LibraryBar";
import LibraryResultCard from "./LibraryResultCard";
import MessageBubble from "./MessageBubble";

/** Static renders, like SearchResultCard.test.tsx: what reaches the screen. */

function result(overrides: Partial<LibrarySearchResult> = {}): LibrarySearchResult {
  return {
    query: "ocelot",
    mode: "exact",
    prepared: "ocelot",
    hits: [
      {
        docId: 1,
        displayName: "Tenders/2026/notice.pdf",
        stillIndexing: false,
        pageNo: 3,
        pageLabel: "iii",
        source: "text",
        matchedIn: ["layer"],
        ocrOnly: false,
        snippet: [{ text: "the ", hit: false }, { text: "ocelot", hit: true }],
      },
      {
        docId: 2,
        displayName: "db:42 · scan.pdf",
        stillIndexing: true,
        pageNo: 1,
        pageLabel: null,
        source: "ocr",
        matchedIn: ["ocr"],
        ocrOnly: true,
        snippet: [{ text: "ocelot", hit: true }],
      },
    ],
    nextCursor: null,
    counts: { pages: 2, documents: 2, complete: true },
    looseCount: null,
    limit: 50,
    tookMs: 3,
    ...overrides,
  };
}

const card = (props: Parameters<typeof LibraryResultCard>[0]) => renderToStaticMarkup(<LibraryResultCard {...props} />);

describe("LibraryResultCard", () => {
  it("shows hits grouped by document, with the folder path / database id, pages, labels and badges", () => {
    const html = card({ response: { status: "ok", result: result() } });
    expect(html).toContain("Library");
    expect(html).toContain("found on <span class=\"text-primary\">2 pages</span> in 2 documents");
    expect(html).toContain("Tenders/2026/notice.pdf");
    expect(html).toContain("db:42 · scan.pdf");
    expect(html).toContain("Page 3");
    expect(html).toContain("printed as iii");
    expect(html).toContain(">OCR<");
    expect(html).toContain(">indexing<");
    expect(html).not.toContain("Show next");
  });

  it("says 'at least' when counting stopped at its time budget, and offers the next window", () => {
    const html = card({ response: { status: "ok", result: result({ counts: { pages: 9000, documents: 400, complete: false }, nextCursor: 123 }) } });
    expect(html).toContain("at least 9,000 pages");
    expect(html).toContain("in at least 400 documents");
    expect(html).toContain("Show next 50");
  });

  it("counts what's left when the count is exact", () => {
    expect(card({ response: { status: "ok", result: result({ counts: { pages: 300, documents: 3, complete: true }, nextCursor: 9 }) } })).toContain("Show next 50 · 298 more pages");
    expect(card({ response: { status: "ok", result: result({ counts: { pages: 30, documents: 3, complete: true }, nextCursor: 9 }) } })).toContain("Show the remaining 28 pages");
  });

  it("has a plain message for every way a library search comes back empty", () => {
    expect(card({ response: { status: "disconnected" } })).toContain("Library drive not connected");
    expect(card({ response: { status: "unconfigured" } })).toContain("Library not set up");
    expect(card({ response: { status: "empty" } })).toContain("Nothing in the library has been indexed yet");
    expect(card({ response: { status: "too-short", query: "ab" } })).toContain("Type at least 3 characters");
    expect(card({ failure: "Library search failed (500)" })).toContain("Library search failed");
    const none = card({ response: { status: "ok", result: result({ hits: [], counts: { pages: 0, documents: 0, complete: true }, looseCount: 4 }) } });
    expect(none).toContain("No matches in the library");
    expect(none).toContain("4 pages match without exact punctuation");
  });
});

describe("LibraryBar", () => {
  it("renders nothing with the library off (the default)", () => {
    expect(renderToStaticMarkup(<LibraryBar />)).toBe("");
    expect(
      renderToStaticMarkup(
        <FeaturesProvider features={{ chatEnabled: false }}>
          <LibraryBar />
        </FeaturesProvider>
      )
    ).toBe("");
  });

  it("with the library on: the scope switch, starting at the configured default, and the status line", () => {
    const html = renderToStaticMarkup(
      <FeaturesProvider features={{ chatEnabled: false, libraryEnabled: true, defaultScope: "both" }}>
        <LibraryBar />
      </FeaturesProvider>
    );
    expect(html).toContain('role="radiogroup" aria-label="Search in"');
    expect(html).toMatch(/aria-checked="false"[^>]*>This session</);
    expect(html).toMatch(/aria-checked="false"[^>]*>Library</);
    expect(html).toMatch(/aria-checked="true"[^>]*>Both</);
    expect(html).toContain("Library: checking…");
  });

  it("status line text: documents, pages, still indexing, not indexed, drive connected or not", () => {
    expect(statusText({ configured: true, connected: true, documents: 48210, pagesIndexed: 2104332, indexing: 312, failed: 14 })).toBe(
      "Library: 48,210 documents · 2,104,332 pages indexed · 312 still indexing · 14 not indexed · drive connected"
    );
    expect(statusText({ configured: true, connected: false, documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 })).toBe("Library drive not connected");
    expect(statusText({ configured: false, connected: false, documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 })).toBe("Library not set up on this server");
  });
});

describe("message rendering", () => {
  const base: DisplayMessage = { id: "a", role: "assistant", content: "", reasoning: "", reasoningMs: null, isStreaming: false, failure: null };

  it("a turn with a library result shows the library card (chat off)", () => {
    const html = renderToStaticMarkup(
      <FeaturesProvider features={{ chatEnabled: false, libraryEnabled: true }}>
        <MessageBubble message={{ ...base, libraryResult: { status: "disconnected" } }} />
      </FeaturesProvider>
    );
    expect(html).toContain("Library drive not connected");
  });

  it("and with chat on, above the reply", () => {
    const html = renderToStaticMarkup(
      <FeaturesProvider features={{ chatEnabled: true, libraryEnabled: true }}>
        <MessageBubble message={{ ...base, content: "the model's reply", libraryResult: { status: "ok", result: result() } }} />
      </FeaturesProvider>
    );
    expect(html.indexOf("Tenders/2026/notice.pdf")).toBeGreaterThan(-1);
    expect(html.indexOf("Tenders/2026/notice.pdf")).toBeLessThan(html.indexOf("the model&#x27;s reply"));
  });

  it("a turn without one renders exactly as before", () => {
    const withLib = renderToStaticMarkup(
      <FeaturesProvider features={{ chatEnabled: false, libraryEnabled: true }}>
        <MessageBubble message={{ ...base, noFiles: true }} />
      </FeaturesProvider>
    );
    const without = renderToStaticMarkup(
      <FeaturesProvider features={{ chatEnabled: false }}>
        <MessageBubble message={{ ...base, noFiles: true }} />
      </FeaturesProvider>
    );
    expect(withLib).toBe(without);
  });
});
