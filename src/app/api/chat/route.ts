import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { StreamEvent } from "@/lib/types";

// Node runtime: we're proxying a long-lived stream to a local process,
// no need (or benefit) to run this on the edge runtime.
export const runtime = "nodejs";

const client = new OpenAI({
  baseURL: process.env.LM_STUDIO_BASE_URL ?? "http://localhost:1234/v1",
  apiKey: "lm-studio", // LM Studio ignores the value but the SDK requires one
});

const MODEL = process.env.LM_STUDIO_MODEL ?? "qwen/qwen3-4b";

// LM Studio (via its reasoning-capable models, e.g. Qwen3) adds a
// `reasoning_content` field to the delta alongside the standard `content`
// field. The OpenAI SDK's types don't know about it since it's outside
// the official API surface, so we extend the delta type locally.
type ReasoningDelta = ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
};

export async function POST(req: Request) {
  let messages: ChatCompletionMessageParam[];
  try {
    const body = await req.json();
    messages = body.messages;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response("`messages` array is required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        // Passing req.signal means: if the client aborts the fetch (stop
        // button, tab close, navigation), that cancellation propagates
        // down to the in-flight request to LM Studio too, instead of
        // leaving it generating in the background.
        const completion = await client.chat.completions.create(
          {
            model: MODEL,
            messages,
            stream: true,
          },
          { signal: req.signal }
        );

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta as ReasoningDelta | undefined;
          if (!delta) continue;

          if (delta.reasoning_content) {
            send({ type: "reasoning", text: delta.reasoning_content });
          }
          if (delta.content) {
            send({ type: "content", text: delta.content });
          }
        }

        send({ type: "done" });
      } catch (err) {
        // An abort from the client shows up here as an error too (either
        // req.signal.aborted, or the SDK throwing on the cancelled fetch).
        // That's an expected stop, not a failure — don't report it.
        if (!req.signal.aborted) {
          const message =
            err instanceof Error
              ? err.message
              : "Unknown error contacting LM Studio";
          send({ type: "error", message });
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
