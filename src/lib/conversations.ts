import { createId } from "./id";
import type { Conversation, DisplayMessage } from "./types";

const TITLE_MAX_LENGTH = 40;

/** Static, non-random placeholder rendered before hydration completes. */
export const EMPTY_CONVERSATION: Conversation = {
  id: "__empty__",
  title: "",
  messages: [],
  createdAt: 0,
  updatedAt: 0,
};

export function createEmptyConversation(): Conversation {
  const now = Date.now();
  return { id: createId(), title: "", messages: [], createdAt: now, updatedAt: now };
}

/** Whitespace-collapsed, wrapping quotes/trailing punctuation stripped, truncated to ~40 chars. Shared by the raw first-message fallback and the model-generated title, so both end up the same shape. */
export function cleanTitle(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ");
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  t = t.replace(/[.!?]+$/, "");
  if (t.length <= TITLE_MAX_LENGTH) return t;
  return `${t.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}

/**
 * Fast, local, synchronous fallback: the first user message, cleaned up.
 * Used the instant a conversation's first message is sent, so the sidebar
 * never shows a blank title while the model-generated one (see
 * src/lib/titleClient.ts) is still in flight -- and as the permanent title
 * if that call fails or LM Studio is unreachable.
 */
export function deriveTitle(messages: DisplayMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";
  return cleanTitle(firstUser.content);
}
