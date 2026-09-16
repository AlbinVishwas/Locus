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
}

export interface Conversation {
  id: string;
  /** Empty until derived from the first user message. */
  title: string;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
}
