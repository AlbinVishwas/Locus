import type { StreamEvent } from "./types";

/**
 * Reads a fetch Response body as our custom SSE protocol (see
 * /api/chat/route.ts) and yields one StreamEvent per `data: ...` line.
 *
 * SSE events are separated by a blank line ("\n\n"). We buffer chunks
 * until we see that separator, since a single read() can split an event
 * across two chunks (or bundle multiple events into one).
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataLine = rawEvent
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) continue;

        yield JSON.parse(dataLine.slice("data: ".length)) as StreamEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
