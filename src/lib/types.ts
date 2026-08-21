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
}

export interface Conversation {
  id: string;
  /** Empty until derived from the first user message. */
  title: string;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
}
