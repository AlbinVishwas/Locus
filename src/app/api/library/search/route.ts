import { extractQuotedText } from "@/lib/chat/documentSearch";
import { getLibraryDb, libraryErrorStatus } from "@/lib/library/db";
import { librarySearch } from "@/lib/library/query";
import type { LibrarySearchResponse } from "@/lib/libraryClient";

// better-sqlite3 is a native Node module; it cannot run on the edge runtime.
export const runtime = "nodejs";

const MAX_MESSAGE_CHARS = 20_000;

/**
 * Searches the document library. 404 unless LOCUS_LIBRARY_ENABLED=true --
 * with the library off this route behaves as if it didn't exist.
 *
 *   { message }                  a turn: the quoted text if any, else the whole message
 *   { query, mode, cursor }      "show more" (or the loose-mode switch) for a result on screen
 *
 * A missing drive is an answer ("disconnected"), not an error: the card
 * says "Library drive not connected". POST, like /api/session-search, so
 * the query never lands in a URL or an access log.
 */
export async function POST(req: Request) {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return new Response("Not found", { status: 404 });

  let body: { message?: unknown; query?: unknown; mode?: unknown; cursor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const isPage = body?.query !== undefined;
  const text = isPage ? body.query : body?.message;
  if (typeof text !== "string" || text.trim() === "") {
    return new Response(isPage ? "`query` must contain some text" : "`message` must contain some text", { status: 400 });
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return new Response(`\`${isPage ? "query" : "message"}\` is limited to ${MAX_MESSAGE_CHARS} characters`, { status: 400 });
  }
  const mode = isPage ? body.mode : "exact";
  if (mode !== "exact" && mode !== "loose") return new Response('`mode` must be "exact" or "loose"', { status: 400 });
  const cursor = isPage ? body.cursor : 0;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) {
    return new Response("`cursor` must be a non-negative integer", { status: 400 });
  }

  const json = (r: LibrarySearchResponse) => Response.json(r, { headers: { "Cache-Control": "no-store" } });
  if (conn.status !== "ok") return json({ status: conn.status });

  const query = isPage ? text.trim() : (extractQuotedText(text) ?? text).trim();
  try {
    const outcome = librarySearch(conn.db, query, { mode, cursor });
    return json(outcome);
  } catch (err) {
    if (libraryErrorStatus(err) === "disconnected") return json({ status: "disconnected" });
    // The query itself is never logged: it may quote a client document.
    console.error("[/api/library/search] search failed", { error: err instanceof Error ? err.message : err });
    return new Response("Library search failed. See the server log for details.", { status: 500 });
  }
}
