import { extractQuotedText } from "@/lib/chat/documentSearch";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { ownedSources, type OwnedSource } from "@/lib/library/sources/owned";
import { activityFor, requireSourcesAccess } from "@/lib/session";
import type { SessionUser } from "@/lib/users/signin";
import { usersEnabled } from "@/lib/users/mode";
import type { LibrarySearchResult } from "@/lib/library/query";
import { getLibraryDb, libraryErrorStatus } from "@/lib/library/db";
import { librarySearch } from "@/lib/library/query";
import type { LibrarySearchResponse } from "@/lib/libraryClient";

// better-sqlite3 is a native Node module; it cannot run on the edge runtime.
export const runtime = "nodejs";

const MAX_MESSAGE_CHARS = 20_000;

function emptyResult(query: string, mode: "exact" | "loose", cursor: number): LibrarySearchResult {
  return { query, mode, prepared: "", hits: [], nextCursor: null, counts: cursor === 0 ? { pages: 0, documents: 0, complete: true } : null, looseCount: null, limit: 50, tookMs: 0 };
}

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
  // Users mode: the administrator searches the whole library. Everyone else is let in only with
  // LOCUS_USER_SOURCES=true, and then searches only the folders they added themselves.
  let admin: SessionUser | null = null;
  let mine: OwnedSource[] | null = null;
  if (usersEnabled()) {
    const gate = await requireSourcesAccess(req);
    if (!gate.ok) return gate.response;
    admin = gate.user;
    if (admin?.role !== "admin") mine = ownedSources(conn.status === "ok" ? conn.db : null, admin!.id);
  }

  let body: { message?: unknown; query?: unknown; mode?: unknown; cursor?: unknown; source?: unknown };
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

  // One source, by its id; unknown ids simply have no results.
  let sourceOrdinal: number | undefined;
  let sourceOrdinals: number[] | undefined;
  let scope = mine ? "my-folders" : "all-sources";
  if (mine) {
    // Only the account's own folders that the indexer has reached; anything else finds nothing.
    sourceOrdinals = mine.filter((s) => s.ordinal !== null).map((s) => s.ordinal as number);
  }
  if (body.source !== undefined) {
    if (typeof body.source !== "string" || body.source.length > 200) return new Response("`source` must be a source id", { status: 400 });
    if (mine) {
      // One of their own folders, or nothing: someone else's id is indistinguishable from one that doesn't exist.
      const own = mine.find((s) => s.id === body.source);
      if (!own || own.ordinal === null) return json({ status: "ok", result: emptyResult(text, mode, cursor), source: body.source });
      sourceOrdinal = own.ordinal;
      sourceOrdinals = undefined;
      scope = `source:${own.name}`;
    } else {
      const row = conn.db.prepare("SELECT ordinal, coalesce(name, kind) AS name FROM sources WHERE id = ?").get(body.source) as { ordinal: number | null; name: string } | undefined;
      if (!row) return json({ status: "ok", result: emptyResult(text, mode, cursor), source: body.source });
      sourceOrdinal = row.ordinal ?? 0;
      scope = `source:${row.name}`;
    }
  }

  const query = isPage ? text.trim() : (extractQuotedText(text) ?? text).trim();
  const started = performance.now();
  const record = (a: { pages?: number; documents?: number; status?: "ok" | "error"; message?: string }) => {
    if (!admin) return;
    logActivity(getRecordsDb(), activityFor(req, admin, { kind: a.status === "error" ? "search_failed" : isPage ? "search_more" : "search", scope, queryText: query, resultPages: a.pages ?? null, resultDocuments: a.documents ?? null, tookMs: performance.now() - started, status: a.status ?? "ok", message: a.message ?? null }));
  };
  try {
    const outcome = librarySearch(conn.db, query, { mode, cursor, sourceOrdinal, sourceOrdinals });
    if (outcome.status === "ok") record({ pages: outcome.result.counts?.pages, documents: outcome.result.counts?.documents });
    else record({ message: outcome.status });
    return json(outcome.status === "ok" && typeof body.source === "string" ? { ...outcome, source: body.source } : outcome);
  } catch (err) {
    if (libraryErrorStatus(err) === "disconnected") {
      record({ status: "error", message: "library drive not connected" });
      return json({ status: "disconnected" });
    }
    // The query itself stays out of the server log (it may quote a client document); the admin's activity log has it.
    console.error("[/api/library/search] search failed", { error: err instanceof Error ? err.message : err });
    record({ status: "error", message: err instanceof Error ? err.message : "search failed" });
    return new Response("Library search failed. See the server log for details.", { status: 500 });
  }
}
