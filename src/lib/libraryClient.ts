import type { LibrarySearchResult } from "./library/query";

/**
 * Browser-side calls to /api/library/*. Only made when the library is
 * enabled (FeaturesProvider's libraryEnabled); with it off, nothing here
 * runs and those routes answer 404.
 */

/** Why a library search didn't produce results, when it didn't. */
export type LibraryUnavailable = "disconnected" | "empty";

export type LibrarySearchResponse =
  | { status: "ok"; result: LibrarySearchResult; /** Present when the search was limited to one source. */ source?: string }
  | { status: "too-short"; query: string }
  | { status: LibraryUnavailable };

export interface LibraryStatus {
  connected: boolean;
  documents: number;
  pagesIndexed: number;
  /** Files queued or being indexed right now. */
  indexing: number;
  /** Files that couldn't be indexed (failed, skipped as too large, encrypted...). */
  failed: number;
  /** The library's named sources, for the scope dropdown. Absent until there is one. */
  sources?: Array<{ id: string; name: string; kind: string }>;
  /** The indexer's storage numbers. Absent until it has reported. */
  storage?: {
    usedBytes: number | null;
    capBytes: number | null;
    freeBytes: number | null;
    minFreeBytes: number | null;
    limit: { kind: "cap" | "reserve"; message: string } | null;
  };
}

async function post(body: object, signal?: AbortSignal): Promise<LibrarySearchResponse> {
  const res = await fetch("/api/library/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Library search failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  }
  return (await res.json()) as LibrarySearchResponse;
}

/** One turn's library search: the message's quoted text if any, otherwise the whole message (as session search does). */
export function searchLibrary(message: string, signal?: AbortSignal, source?: string | null): Promise<LibrarySearchResponse> {
  return post({ message, ...(source ? { source } : {}) }, signal);
}

/** The next window of hits, or the same query in another mode: `query` exactly as a result reported it. */
export function searchLibraryPage(query: string, mode: LibrarySearchResult["mode"], cursor: number, source?: string | null): Promise<LibrarySearchResponse> {
  return post({ query, mode, cursor, ...(source ? { source } : {}) });
}

export async function getLibraryStatus(): Promise<LibraryStatus | null> {
  const res = await fetch("/api/library/status", { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as LibraryStatus;
}
