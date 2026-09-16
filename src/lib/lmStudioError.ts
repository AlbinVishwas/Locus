import { APIConnectionError, APIConnectionTimeoutError } from "openai";

/**
 * Turns an SDK error into something that names the actual failure.
 *
 * This exists because the OpenAI SDK collapses every transport failure into
 * the single string "Connection error." — indistinguishable whether LM Studio
 * is down, the tunnel's DNS is dead, or TLS was rejected. Extracted from the
 * route so it can be tested without standing up a server.
 */

/**
 * undici nests the real reason two levels down: the SDK's "Connection error."
 * wraps a bare "TypeError: fetch failed", which in turn wraps the thing that
 * actually says ECONNREFUSED / ENOTFOUND / a TLS failure. Walk to the bottom
 * of the chain and report that, since the outer layers carry no information.
 */
export function rootCause(err: Error): string | null {
  let current: Error = err;
  let detail: string | null = null;

  // Bounded so a self-referential cause chain can't spin.
  for (let depth = 0; depth < 5; depth++) {
    const next = current.cause;
    if (!(next instanceof Error)) break;
    current = next;

    const code = (current as NodeJS.ErrnoException).code;
    // "fetch failed" is undici's contentless wrapper — keep unwrapping past
    // it, but hold on to it in case there is nothing better underneath.
    if (code || current.message !== "fetch failed") {
      detail = code ? `${code}: ${current.message}` : current.message;
    }
  }

  return detail;
}

/**
 * Timeouts and connection failures are both APIConnectionError, so they have
 * to be separated by class — and in that order, since the timeout class
 * extends the connection class.
 */
export function describeLmStudioError(
  err: unknown,
  baseURL: string,
  timeoutMs: number
): string {
  if (err instanceof APIConnectionTimeoutError) {
    return `LM Studio at ${baseURL} did not respond within ${timeoutMs / 1000}s.`;
  }

  if (err instanceof APIConnectionError) {
    const detail = rootCause(err);
    return `Could not reach LM Studio at ${baseURL}${detail ? ` — ${detail}` : "."}`;
  }

  return err instanceof Error ? err.message : "Unknown error contacting LM Studio";
}
