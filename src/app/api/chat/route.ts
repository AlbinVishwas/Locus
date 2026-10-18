import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { StreamEvent } from "@/lib/types";
import { DOCUMENT_SEARCH_SYSTEM_NOTE, runDocumentSearch } from "@/lib/chat/documentSearch";
import { shouldSuppressReasoning, withReasoningSuppressed } from "@/lib/chat/reasoning";
import { validateChatRequest } from "@/lib/chatRequest";
import { describeLmStudioError } from "@/lib/lmStudioError";
import { lmStudioClient } from "@/lib/lmStudioClient";
import {
  buildUrlContextPrompt,
  extractUrls,
  fetchUrlContexts,
} from "@/lib/urlContext";

// Node runtime: we're proxying a long-lived stream to a local process,
// no need (or benefit) to run this on the edge runtime.
export const runtime = "nodejs";

// A slow page fetch can take over a minute before the model is even called,
// which exceeds the platform default and would kill the request mid-flight.
export const maxDuration = 120;

/**
 * The SDK default is 10 minutes, which is indistinguishable from a hang when
 * the endpoint is a tunnel that has quietly gone away. This bounds the wait
 * for the response to start; once the stream is flowing it is not re-armed.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.LM_STUDIO_TIMEOUT_MS ?? 120_000);

function lmStudio() {
  return lmStudioClient(REQUEST_TIMEOUT_MS);
}

// LM Studio (via its reasoning-capable models, e.g. Qwen3) adds a
// `reasoning_content` field to the delta alongside the standard `content`
// field. The OpenAI SDK's types don't know about it since it's outside
// the official API surface, so we extend the delta type locally.
type ReasoningDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
};

/** How far back to look for a link when the current message has none. */
const FOLLOW_UP_WINDOW = 6;

/** Index of the newest user message, or -1. */
function latestUserIndex(messages: ChatCompletionMessageParam[]): number {
  return messages.findLastIndex(
    (m) => m.role === "user" && typeof m.content === "string"
  );
}

/**
 * Picks the URLs to expand for this turn.
 *
 * Normally that's whatever the current message links to. When it links to
 * nothing, we look back over the last FOLLOW_UP_WINDOW messages for the most
 * recent user message that did — so "now show me just the second column"
 * still has the table in context. Older links stay out of reach on purpose:
 * a link from twenty messages ago is rarely what the user means now.
 *
 * The pages are always re-fetched; nothing is cached between turns, so the
 * model sees the page as it is now rather than as it was.
 */
function urlsToExpand(messages: ChatCompletionMessageParam[]): string[] {
  const current = latestUserIndex(messages);
  if (current === -1) return [];

  const currentUrls = extractUrls(messages[current].content as string);
  if (currentUrls.length > 0) return currentUrls;

  const start = Math.max(0, current - FOLLOW_UP_WINDOW);
  for (let i = current - 1; i >= start; i--) {
    const message = messages[i];
    if (message.role !== "user" || typeof message.content !== "string") continue;

    const urls = extractUrls(message.content);
    if (urls.length > 0) return urls;
  }

  return [];
}

/**
 * Returns a copy of the message list with the final user message replaced by
 * the URL-context prompt. Copied rather than mutated so the caller's array —
 * which mirrors what the client sent — stays untouched.
 */
function withExpandedUserMessage(
  messages: ChatCompletionMessageParam[],
  results: Awaited<ReturnType<typeof fetchUrlContexts>>
): ChatCompletionMessageParam[] {
  const index = messages.findLastIndex(
    (m) => m.role === "user" && typeof m.content === "string"
  );
  if (index === -1) return messages;

  const original = messages[index].content as string;
  const copy = [...messages];
  copy[index] = {
    role: "user",
    content: buildUrlContextPrompt(results, original),
  };
  return copy;
}

export async function POST(req: Request) {
  let messages: ChatCompletionMessageParam[];
  let conversationId: string | null;
  try {
    const body = await req.json();
    const validation = validateChatRequest(body);
    if (!validation.ok) {
      return new Response(validation.error, { status: 400 });
    }
    messages = validation.messages;
    conversationId = validation.conversationId;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      const { client, model, baseURL } = lmStudio();

      try {
        // Document search runs first, synchronously, before anything else:
        // it's deterministic and near-instant (the index is built for this),
        // so there's no reason to make the user wait for the model just to
        // learn whether their files mention something. Skipped entirely
        // when this conversation has no uploads -- the common case -- so
        // ordinary chat is completely unaffected.
        let documentSearchRan = false;
        if (conversationId !== null) {
          const current = latestUserIndex(messages);
          if (current !== -1) {
            const outcome = runDocumentSearch(
              conversationId,
              messages[current].content as string
            );
            if (outcome) {
              documentSearchRan = true;
              send({
                type: "searchResult",
                result: outcome.result,
                looseAlternative: outcome.looseAlternative,
              });
            }
          }
        }

        // If this turn has page context to pull in — from the current
        // message or, for follow-ups, a recent one — fetch it and swap in an
        // expanded prompt. This happens per-request and is never persisted:
        // the browser keeps sending the text the user typed, so the UI and the
        // stored conversation stay free of the wrapper, and which message the
        // links came from is never revealed to the client.
        let outbound = messages;
        const urls = urlsToExpand(messages);

        if (urls.length > 0) {
          send({ type: "fetching", urls });
          const results = await fetchUrlContexts(urls, req.signal);
          outbound = withExpandedUserMessage(messages, results);
        }

        if (shouldSuppressReasoning(model)) {
          outbound = withReasoningSuppressed(outbound);
        }

        // The note is prepended as its own system message, never mixed into
        // the user's own message text, and -- like the URL-context prompt
        // above -- only ever applied to `outbound`, the copy sent to the
        // model. `messages` (what gets echoed back as history) never sees it.
        if (documentSearchRan) {
          outbound = [{ role: "system", content: DOCUMENT_SEARCH_SYSTEM_NOTE }, ...outbound];
        }

        // Passing req.signal means: if the client aborts the fetch (stop
        // button, tab close, navigation), that cancellation propagates
        // down to the in-flight request to LM Studio too, instead of
        // leaving it generating in the background.
        const completion = await client.chat.completions.create(
          {
            model,
            messages: outbound,
            stream: true,
          },
          { signal: req.signal }
        );

        let emitted = false;

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta as ReasoningDelta | undefined;
          if (!delta) continue;

          if (delta.reasoning_content) {
            emitted = true;
            send({ type: "reasoning", text: delta.reasoning_content });
          }
          if (delta.content) {
            emitted = true;
            send({ type: "content", text: delta.content });
          }
        }

        // A stream that ends without a single token is not success. The SDK
        // only throws on a non-2xx, so anything that answers 200 without being
        // an OpenAI-compatible stream — a proxy's HTML interstitial, an empty
        // body, a non-streamed JSON reply — arrives here as a clean, empty
        // iteration. Reporting "done" would render as a blank answer with no
        // explanation, which is the failure mode this route exists to avoid.
        if (!emitted) {
          console.error("[/api/chat] LM Studio returned no completion data", {
            baseURL,
            model,
          });
          send({
            type: "error",
            message:
              `LM Studio at ${baseURL} answered, but returned no completion data. ` +
              `Check that the URL points at an OpenAI-compatible endpoint (it should end in /v1) ` +
              `and that the model "${model}" is loaded.`,
          });
          return;
        }

        send({ type: "done" });
      } catch (err) {
        // An abort from the client shows up here as an error too (either
        // req.signal.aborted, or the SDK throwing on the cancelled fetch).
        // That's an expected stop, not a failure — don't report it.
        if (!req.signal.aborted) {
          // The SDK collapses every transport failure into the string
          // "Connection error." and hides the real cause (ECONNREFUSED, a TLS
          // failure, a proxy/dispatcher mismatch) on err.cause. Log the whole
          // thing before it gets flattened into a one-line UI message.
          console.error("[/api/chat] request to LM Studio failed", {
            baseURL,
            model,
            error: err,
            cause: err instanceof Error ? err.cause : undefined,
          });
          send({
            type: "error",
            message: describeLmStudioError(err, baseURL, REQUEST_TIMEOUT_MS),
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables buffering if this ever sits behind nginx in front of `next start`.
      "X-Accel-Buffering": "no",
    },
  });
}
