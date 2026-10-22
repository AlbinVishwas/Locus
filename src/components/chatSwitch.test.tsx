import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SearchResult } from "@/lib/search/query";
import type { DisplayMessage } from "@/lib/types";
import ChatInput from "./ChatInput";
import ConversationHeader from "./ConversationHeader";
import EmptyState from "./EmptyState";
import { FeaturesProvider } from "./FeaturesProvider";
import MessageBubble from "./MessageBubble";

/**
 * What the chat switch (src/config/features.ts) changes on screen, in both
 * states: wording, and which model-only pieces render at all. Static
 * render, same approach as Markdown.test.tsx and SearchResultCard.test.tsx.
 * The model pill fetches its name after mount, so it never appears in a
 * static render either way -- that it's not *mounted* with chat off is
 * covered by the end-to-end run (scripts/e2e-search-only.mjs).
 */

const noop = () => {};

function render(chatEnabled: boolean, node: React.ReactNode): string {
  return renderToStaticMarkup(<FeaturesProvider features={{ chatEnabled }}>{node}</FeaturesProvider>);
}

const emptyState = (
  <EmptyState
    isStreaming={false}
    onSend={noop}
    onStop={noop}
    files={[]}
    uploading={[]}
    onAttachFiles={noop}
    onRemoveFile={noop}
  />
);

function assistant(overrides: Partial<DisplayMessage>): DisplayMessage {
  return {
    id: "a",
    role: "assistant",
    content: "",
    reasoning: "",
    reasoningMs: null,
    isStreaming: false,
    ...overrides,
  };
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
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

describe("chat off (search-only)", () => {
  it("empty state reads like a search tool, with no Read a link chip", () => {
    const html = render(false, emptyState);
    expect(html).toContain("Search your documents");
    expect(html).toContain("Type a word or phrase to find it in your files");
    expect(html).toContain("Upload documents");
    expect(html).toContain("Find a phrase");
    expect(html).not.toContain("Find a phrase in files");
    expect(html).not.toContain("Read a link");
    expect(html).not.toMatch(/Good (morning|afternoon|evening)/);
    expect(html).toContain("private to their session");
  });

  it("an untitled session's header says New session", () => {
    expect(render(false, <ConversationHeader title="" fileCount={0} />)).toContain("New session");
  });

  it("the pinned composer uses the search placeholder", () => {
    const html = render(
      false,
      <ChatInput
        isStreaming={false}
        onSend={noop}
        onStop={noop}
        files={[]}
        uploading={[]}
        onAttachFiles={noop}
        onRemoveFile={noop}
      />
    );
    expect(html).toContain("Type a word or phrase to find it in your files");
    expect(html).toContain('aria-label="Search"');
  });

  it("an in-flight turn shows Searching, never Thinking", () => {
    const html = render(false, <MessageBubble message={assistant({ isStreaming: true })} fileCount={2} />);
    expect(html).toContain("Searching 2 files");
    expect(html).not.toContain("Thinking");
    expect(html).not.toContain("Writing");
  });

  it("zero matches still shows a card, with No matches in your files and the punctuation hint", () => {
    const loose = result({ mode: "loose", totalPages: 2, totalDocuments: 1 });
    const html = render(
      false,
      <MessageBubble message={assistant({ searchResult: result(), looseAlternative: loose })} />
    );
    expect(html).toContain("No matches in your files");
    expect(html).toContain("rounded-xl border");
    expect(html).toContain("without exact punctuation");
  });

  it("a session with no files gets the upload prompt", () => {
    const html = render(false, <MessageBubble message={assistant({ noFiles: true })} />);
    expect(html).toContain("This session has no documents yet");
  });
});

describe("chat on (unchanged)", () => {
  it("empty state keeps the greeting, chat placeholder and all three chips", () => {
    const html = render(true, emptyState);
    expect(html).toMatch(/Good (morning|afternoon|evening)/);
    expect(html).toContain("Ask anything, or drop PDFs to search inside them");
    expect(html).toContain("Find a phrase in files");
    expect(html).toContain("Read a link");
    expect(html).not.toContain("Search your documents");
  });

  it("an untitled conversation's header says New chat", () => {
    expect(render(true, <ConversationHeader title="" fileCount={0} />)).toContain("New chat");
  });

  it("an in-flight turn shows Thinking", () => {
    const html = render(true, <MessageBubble message={assistant({ isStreaming: true })} />);
    expect(html).toContain("Thinking");
  });

  it("zero matches stays the quiet one-line message above the reply", () => {
    const html = render(true, <MessageBubble message={assistant({ searchResult: result() })} />);
    expect(html).toContain("No page in this conversation");
    expect(html).not.toContain("No matches in your files");
  });
});
