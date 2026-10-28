import fs from "node:fs";
import { Readable } from "node:stream";
import { errorResponse } from "@/lib/errors/catalog";
import { authorizeConversation } from "@/lib/session";
import { storedPathFor } from "@/lib/uploads/storage";
import { getWritableDb } from "@/lib/uploads/writableDb";
import { uploadedDocuments } from "../../../../../scripts/indexer/store";

export const runtime = "nodejs";

/**
 * GET /api/uploads/file?conversationId=<id>&docId=<id>  --  the PDF a person uploaded, opened again from a search
 * result. Only the session's owner (authorizeConversation), only a document of that session, and the stored name
 * comes from the index, never from the request.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  const docId = Number(url.searchParams.get("docId"));
  if (!conversationId || conversationId.length > 200 || !Number.isInteger(docId) || docId <= 0) return errorResponse("LOCUS-NOTFOUND-001");
  const auth = await authorizeConversation(req, conversationId);
  if (!auth.ok) return auth.response;
  const doc = uploadedDocuments(getWritableDb(), conversationId).find((d) => d.id === docId);
  if (!doc) return errorResponse("LOCUS-NOTFOUND-001");
  const file = storedPathFor(doc.sha256);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return errorResponse("LOCUS-NOTFOUND-001");
  }
  const name = (doc.originalFilename ?? "document.pdf").split("/").pop()!.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
