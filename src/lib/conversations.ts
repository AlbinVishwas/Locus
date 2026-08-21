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

/** First user message, whitespace-collapsed and truncated to ~40 chars. */
export function deriveTitle(messages: DisplayMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "";

  const collapsed = firstUser.content.trim().replace(/\s+/g, " ");
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}
