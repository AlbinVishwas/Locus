import path from "node:path";
import { indexPath } from "@/lib/search/indexDb";
import { ensureRetentionScheduleStarted } from "@/lib/uploads/cleanup";
import { maxFilesPerConversation, maxUploadFileBytes, storageCapBytes, uploadsEnabled } from "@/lib/uploads/config";
import { deleteConversationUploads, deleteSingleUpload, indexUpload, type UploadStage } from "@/lib/uploads/pipeline";
import { measureStorageUsage } from "@/lib/uploads/storage";
import { sanitizeOriginalFilename, validateUploadBytes } from "@/lib/uploads/validate";
import { getWritableDb } from "@/lib/uploads/writableDb";
import { uploadedDocuments } from "../../../../scripts/indexer/store";

// better-sqlite3 and the poppler/tesseract child processes are Node-only.
export const runtime = "nodejs";

const MAX_CONVERSATION_ID_CHARS = 200;

function badConversationId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CONVERSATION_ID_CHARS) {
    return "`conversationId` must be a non-empty string";
  }
  return null;
}

/**
 * Uploads one file into a conversation, streaming progress as the file
 * moves through reading -> indexing -> (OCR, if any pages need it) ->
 * ready, as Server-Sent Events -- the same shape as /api/chat's streaming
 * protocol, for the same reason: the browser shows real progress instead
 * of a spinner for however long OCR takes.
 */
export async function POST(req: Request) {
  if (!uploadsEnabled()) {
    return new Response(
      "Uploads are disabled. Set LOCUS_ENABLE_UPLOADS=true only for a trusted local deployment.",
      { status: 403 }
    );
  }
  ensureRetentionScheduleStarted();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return new Response("Expected multipart/form-data", { status: 400 });
  }

  const conversationId = formData.get("conversationId");
  const idError = badConversationId(conversationId);
  if (idError) return new Response(idError, { status: 400 });

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return new Response("`file` is required", { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const validation = validateUploadBytes(bytes, maxUploadFileBytes());
  if (!validation.ok) {
    return new Response(validation.error, { status: 400 });
  }

  const existing = uploadedDocuments(getWritableDb(), conversationId as string);
  if (existing.length >= maxFilesPerConversation()) {
    return new Response(
      `This conversation already has ${existing.length} files, the limit per conversation`,
      { status: 400 }
    );
  }

  const usage = await measureStorageUsage(path.dirname(indexPath()));
  const cap = storageCapBytes();
  if (usage.totalBytes + bytes.length > cap) {
    return new Response(
      `Storage is full: ${formatMB(usage.totalBytes)} MB of ${formatMB(cap)} MB used. ` +
        `Remove some files or delete old conversations to free space.`,
      { status: 507 }
    );
  }

  const originalFilename = sanitizeOriginalFilename(file.name || "document.pdf");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      send({ type: "stage", stage: "uploading" });

      const onStage = (event: UploadStage) => {
        if (event.stage === "reading" || event.stage === "indexing") {
          send({ type: "stage", stage: event.stage });
        } else if (event.stage === "running-ocr") {
          send({ type: "stage", stage: "running-ocr", page: event.page, totalPages: event.totalPages });
        } else if (event.stage === "ready") {
          send({ type: "ready", docId: event.docId, pageCount: event.pageCount });
        } else if (event.stage === "failed") {
          send({ type: "error", message: event.message });
        }
      };

      try {
        await indexUpload({ conversationId: conversationId as string, originalFilename, bytes, onStage });
      } catch (err) {
        console.error("[/api/uploads] indexing failed", { error: err });
        send({ type: "error", message: "Indexing failed. See the server log for details." });
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
      "X-Accel-Buffering": "no",
    },
  });
}

/** Lists a conversation's uploaded documents: status, page count, expiry. */
export async function GET(req: Request) {
  if (!uploadsEnabled()) {
    return Response.json({ documents: [] });
  }
  ensureRetentionScheduleStarted();
  const conversationId = new URL(req.url).searchParams.get("conversationId");
  const idError = badConversationId(conversationId);
  if (idError) return new Response(idError, { status: 400 });

  const docs = uploadedDocuments(getWritableDb(), conversationId as string);
  return Response.json({ documents: docs }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Deletes files (and index rows) from one conversation: every one of
 * them when called with just `conversationId` (a conversation being
 * deleted entirely), or, with `docId` also given, just that one file --
 * the per-file remove button. `docId` is scoped to `conversationId`
 * server-side, so one conversation can never remove another's file.
 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  const idError = badConversationId(conversationId);
  if (idError) return new Response(idError, { status: 400 });

  const docIdRaw = url.searchParams.get("docId");
  if (docIdRaw !== null) {
    const docId = Number(docIdRaw);
    if (!Number.isInteger(docId) || docId <= 0) {
      return new Response("`docId` must be a positive integer", { status: 400 });
    }
    const deleted = await deleteSingleUpload(conversationId as string, docId);
    if (!deleted) {
      return new Response("No such file in this conversation", { status: 404 });
    }
    return Response.json({ ok: true });
  }

  await deleteConversationUploads(conversationId as string);
  return Response.json({ ok: true });
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
