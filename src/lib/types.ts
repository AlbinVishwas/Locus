import type { SearchResult } from "./search/query";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * Line-delimited SSE payload shape sent from /api/chat to the browser.
 * This is a small custom protocol, not the raw OpenAI stream format —
 * we translate LM Studio's chunks into these before forwarding.
 */
export type StreamEvent =
  /** Emitted before generation starts, while page content is being fetched. */
  | { type: "fetching"; urls: string[] }
  /**
   * Emitted once, before generation starts, when this turn's conversation
   * has uploaded documents. Deterministic -- straight from the index, no
   * model involved -- and never sent back to the model as history (see
   * toHistoryPayload and DisplayMessage.searchResult below).
   */
  | { type: "searchResult"; result: SearchResult; looseAlternative: SearchResult | null }
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * A message as rendered in the UI. Distinct from ChatMessage because it
 * carries reasoning + streaming/timing state that never gets sent back
 * to the API — only { role, content } does.
 */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string;
  /** Wall-clock time reasoning took, in ms. Null until it's known. */
  reasoningMs: number | null;
  isStreaming: boolean;
  /**
   * Why this turn failed, if it did. Rendered in the assistant slot but kept
   * out of `content` on purpose: content is what gets replayed to the model
   * as history, and a transport error is not something the model said.
   */
  failure?: string | null;
  /**
   * This turn's document search results, if any ran. Rendered as its own
   * card, persisted with the message (so it survives a reload) -- but like
   * `reasoning` and `failure`, never part of `content`, so toHistoryPayload
   * never sends it back to the model. See documentSearch.ts.
   */
  searchResult?: SearchResult | null;
  /** The loose-mode fallback the user can switch to with one click, when `searchResult` found nothing under exact punctuation. */
  looseAlternative?: SearchResult | null;
  /**
   * True when this conversation once had uploaded files (an earlier
   * message in it has its own `searchResult`) but has none any more by
   * the time this turn was sent -- they expired and retention cleanup
   * removed them. Set client-side (see Chat.tsx); the server has no
   * record of a document once it's deleted, by design.
   */
  filesExpired?: boolean;
}

export interface Conversation {
  id: string;
  /** Empty until derived from the first user message. */
  title: string;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
}
