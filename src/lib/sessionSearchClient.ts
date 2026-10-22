import type { SearchResult } from "./search/query";

/** Browser-side call to /api/session-search: one search-only turn over a session's own files, used in place of /api/chat when chat is turned off. */

export type SessionSearchResponse =
  | { status: "no-files" }
  | { status: "ok"; result: SearchResult; looseAlternative: SearchResult | null };

export async function searchSession(
  conversationId: string,
  message: string,
  signal?: AbortSignal
): Promise<SessionSearchResponse> {
  const res = await fetch("/api/session-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Search failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  }
  return (await res.json()) as SessionSearchResponse;
}
