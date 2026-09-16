import type { ChatMessage, DisplayMessage } from "./types";

/**
 * Reduces the rendered conversation to what the model is allowed to see.
 *
 * Only { role, content } crosses this boundary. Reasoning, timing, streaming
 * state and failures are UI concerns; in particular a transport failure is
 * something the app reports, not something the assistant said, so replaying it
 * as an assistant turn would put words in the model's mouth on every
 * subsequent request.
 */
export function toHistoryPayload(messages: DisplayMessage[]): ChatMessage[] {
  return messages
    // A turn that produced no text — cancelled, or failed before any token —
    // would otherwise be sent as an empty assistant message.
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}
