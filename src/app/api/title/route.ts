import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { CHAT_DISABLED_MESSAGE, isChatEnabled } from "@/config/features";
import { cleanTitle } from "@/lib/conversations";
import { shouldSuppressReasoning, withReasoningSuppressed } from "@/lib/chat/reasoning";
import { lmStudioClient } from "@/lib/lmStudioClient";

// better-sqlite3-free, but still talks to a local process over HTTP --
// same reasoning as /api/chat for staying off the Edge runtime.
export const runtime = "nodejs";

const MAX_MESSAGE_CHARS = 4000;
// A title is a handful of words; this is well short of /api/chat's own
// REQUEST_TIMEOUT_MS -- a slow title generation degrades to the fast local
// fallback (see deriveTitle) rather than leaving the sidebar waiting.
const TITLE_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = [
  "You title conversations. Given the user's first message, reply with a short",
  "phrase, 2 to 5 words and never more than 6, naming its specific subject --",
  "reuse the message's own key words and names where they exist, rather than a",
  "generic category label like \"Document Inquiry\". Not a direct quote, not a",
  "sentence, not a label with a colon in it -- just the title phrase itself,",
  "with no quotation marks, no trailing punctuation, no markdown.",
].join(" ");

/**
 * Turns a conversation's first message into a short topic phrase for the
 * sidebar, e.g. "does it mention earnest money" -> "Earnest money clause".
 * Deterministic truncation (deriveTitle) is what actually sets the title
 * the instant a message is sent; this is the asynchronous upgrade that
 * replaces it once a real phrase comes back -- see
 * ConversationsProvider.tsx and src/lib/titleClient.ts.
 */
export async function POST(req: Request) {
  // Titling is a model call, so it goes with chat: with chat off a
  // session keeps its first-message title (deriveTitle) for good.
  if (!isChatEnabled()) {
    return new Response(CHAT_DISABLED_MESSAGE, { status: 403 });
  }

  let message: unknown;
  try {
    const body = await req.json();
    message = (body as { message?: unknown })?.message;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return Response.json({ title: "" });
  }

  const { client, model } = lmStudioClient(TITLE_TIMEOUT_MS);
  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message.slice(0, MAX_MESSAGE_CHARS) },
  ];
  if (shouldSuppressReasoning(model)) {
    messages = withReasoningSuppressed(messages);
  }

  // Best-effort: LM Studio being slow, down, or mid-restart (a tunnel
  // address changing, say) degrades silently to the fast local title
  // already showing, never a failed turn or a blocked sidebar.
  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      stream: false,
      max_tokens: 16,
      temperature: 0.3,
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return Response.json({ title: cleanTitle(raw) });
  } catch {
    return Response.json({ title: "" });
  }
}
