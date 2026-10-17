import { getIndexDb, IndexUnavailableError } from "@/lib/search/indexDb";
import { search } from "@/lib/search/query";
import { MAX_BODY_BYTES, validateSearchRequest } from "@/lib/search/searchRequest";

/**
 * Full-text search over the indexed tender PDFs.
 *
 * Reads the index and returns what it finds — nothing else. No language
 * model is involved anywhere: page numbers and snippets come straight from
 * the rows the indexer stored, so they cannot be invented.
 *
 * POST rather than GET so search terms from client documents stay out of
 * URLs, browser history and server access logs.
 */

// better-sqlite3 is a native Node module; it cannot run on the edge runtime.
export const runtime = "nodejs";

export async function POST(req: Request) {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return new Response(`Request body is limited to ${MAX_BODY_BYTES} bytes`, { status: 413 });
  }

  let raw: string;
  let body: unknown;
  try {
    raw = await req.text();
    // A missing or lying Content-Length header doesn't get past this.
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return new Response(`Request body is limited to ${MAX_BODY_BYTES} bytes`, { status: 413 });
    }
    body = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const validation = validateSearchRequest(body);
  if (!validation.ok) {
    return new Response(validation.error, { status: 400 });
  }
  const { query, mode, offset, limit } = validation.request;

  try {
    const result = search(getIndexDb(), query, { mode, offset, limit });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof IndexUnavailableError) {
      return new Response(err.message, { status: 503 });
    }
    // The query itself is never logged: it may quote a client document.
    console.error("[/api/search] search failed", {
      error: err instanceof Error ? err.message : err,
    });
    return new Response("Search failed. See the server log for details.", { status: 500 });
  }
}
