import { runDocumentSearch } from "@/lib/chat/documentSearch";
import { getIndexDb, IndexUnavailableError } from "@/lib/search/indexDb";
import { hasDocumentsForConversation } from "@/lib/search/query";
import type { SessionSearchResponse } from "@/lib/sessionSearchClient";

// better-sqlite3 is a native Node module; it cannot run on the edge runtime.
export const runtime = "nodejs";

const MAX_CONVERSATION_ID_CHARS = 200;
// Same per-message ceiling /api/chat applies (see chatRequest.ts).
const MAX_MESSAGE_CHARS = 20_000;

/**
 * One search-only turn: the user's message searched over that session's
 * own files, exactly as /api/chat's document search does it (quoted text
 * if there is any, otherwise the whole message as exact text, with the
 * loose fallback offered when exact finds nothing) -- and nothing else.
 * No model, no URL fetching: this is what the UI calls instead of
 * /api/chat when chat is turned off (src/config/features.ts).
 *
 * POST rather than GET for the same reason as /api/search: the query may
 * quote a client document, and it shouldn't land in URLs or access logs.
 */
export async function POST(req: Request) {
  let conversationId: unknown;
  let message: unknown;
  try {
    const body = (await req.json()) as { conversationId?: unknown; message?: unknown };
    conversationId = body?.conversationId;
    message = body?.message;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (
    typeof conversationId !== "string" ||
    conversationId.length === 0 ||
    conversationId.length > MAX_CONVERSATION_ID_CHARS
  ) {
    return new Response("`conversationId` must be a non-empty string", { status: 400 });
  }
  if (typeof message !== "string" || message.trim() === "") {
    return new Response("`message` must contain some text", { status: 400 });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return new Response(`\`message\` is limited to ${MAX_MESSAGE_CHARS} characters`, { status: 400 });
  }

  const json = (body: SessionSearchResponse) =>
    Response.json(body, { headers: { "Cache-Control": "no-store" } });

  try {
    // No index file yet (nothing ever uploaded on this machine) means no
    // session has files -- the upload prompt, not an error.
    let hasFiles: boolean;
    try {
      hasFiles = hasDocumentsForConversation(getIndexDb(), conversationId);
    } catch (err) {
      if (err instanceof IndexUnavailableError) return json({ status: "no-files" });
      throw err;
    }
    if (!hasFiles) return json({ status: "no-files" });

    const outcome = runDocumentSearch(conversationId, message);
    // hasFiles was just checked and message is non-blank, so this is only
    // reachable if the files vanished in between (deleted mid-request).
    if (!outcome) return json({ status: "no-files" });
    return json({ status: "ok", result: outcome.result, looseAlternative: outcome.looseAlternative });
  } catch (err) {
    // The query itself is never logged: it may quote a client document.
    console.error("[/api/session-search] search failed", {
      error: err instanceof Error ? err.message : err,
    });
    return new Response("Search failed. See the server log for details.", { status: 500 });
  }
}
