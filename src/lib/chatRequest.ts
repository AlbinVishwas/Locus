import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TOTAL_CONTENT_CHARS = 100_000;
const MAX_CONVERSATION_ID_CHARS = 200;
const VALID_ROLES = new Set(["system", "user", "assistant"]);

type ValidationResult =
  | { ok: true; messages: ChatCompletionMessageParam[]; conversationId: string | null }
  | { ok: false; error: string };

/**
 * Validates the untrusted client payload before it is used for URL fetching or
 * forwarded to LM Studio. The app only persists these three text-only roles.
 */
export function validateChatRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || !("messages" in body)) {
    return { ok: false, error: "`messages` array is required" };
  }

  const { messages, conversationId } = body as { messages: unknown; conversationId?: unknown };

  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" ||
      conversationId.length === 0 ||
      conversationId.length > MAX_CONVERSATION_ID_CHARS)
  ) {
    return { ok: false, error: "`conversationId` must be a non-empty string" };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "`messages` array is required" };
  }

  if (messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      error: `At most ${MAX_MESSAGES} messages are allowed per request`,
    };
  }

  let totalContentChars = 0;
  const validated: ChatCompletionMessageParam[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      return { ok: false, error: "Each message must be an object" };
    }

    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || !VALID_ROLES.has(role)) {
      return {
        ok: false,
        error: "Each message must have a supported role: system, user, or assistant",
      };
    }

    if (typeof content !== "string") {
      return { ok: false, error: "Each message must have string content" };
    }

    if (content.length > MAX_MESSAGE_CHARS) {
      return {
        ok: false,
        error: `Each message is limited to ${MAX_MESSAGE_CHARS} characters`,
      };
    }

    totalContentChars += content.length;
    if (totalContentChars > MAX_TOTAL_CONTENT_CHARS) {
      return {
        ok: false,
        error: `Total message content is limited to ${MAX_TOTAL_CONTENT_CHARS} characters`,
      };
    }

    validated.push({ role, content } as ChatCompletionMessageParam);
  }

  return { ok: true, messages: validated, conversationId: (conversationId as string) ?? null };
}
