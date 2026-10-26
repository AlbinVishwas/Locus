import { createHash } from "node:crypto";
import path from "node:path";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { markConversationUploadsDeleted, markUploadDeleted, recordUpload, releaseConversation } from "@/lib/records/ownership";
import { userUploadBytes } from "@/lib/records/users";
import { activityFor, authorizeConversation } from "@/lib/session";
import { userUploadLimitBytes } from "@/lib/users/mode";
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

  // Users mode: the first signed-in user to use a session owns it; anyone else gets "No such session".
  const auth = await authorizeConversation(req, conversationId as string);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return new Response("`file` is required", { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const validation = validateUploadBytes(bytes, maxUploadFileBytes());
  if (!validation.ok) {
    return new Response(validation.error, { status: 400 });
  }

  // Users mode: each person has their own upload limit under the shared cap.
  if (user) {
    const used = userUploadBytes(getRecordsDb(), user.id);
    const limit = userUploadLimitBytes();
    if (used + bytes.length > limit) {
      logActivity(getRecordsDb(), activityFor(req, user, { kind: "upload_failed", status: "refused", message: "over the per-user upload limit", details: { sizeBytes: bytes.length } }));
      return new Response(
        `You've used ${formatMB(used)} MB of your ${formatMB(limit)} MB upload limit; this file (${formatMB(bytes.length)} MB) would go over it. Remove some of your files first.`,
        { status: 507 }
      );
    }
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

  // Set once the browser goes away (tab closed, reload, tunnel dropped the
  // connection). Indexing carries on regardless -- the file shows up in the
  // conversation's list when it's done -- so sends just stop instead of
  // throwing into indexUpload and aborting it.
  let clientGone = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          clientGone = true;
        }
      };
      const send = (event: object) => write(`data: ${JSON.stringify(event)}\n\n`);

      // Reading a large PDF can go a long while between stage events; an SSE
      // comment keeps proxies and tunnels from closing the connection as idle.
      heartbeat = setInterval(() => write(": keep-alive\n\n"), 15_000);

      send({ type: "stage", stage: "uploading" });

      // Users mode: a record of every upload, ready or failed, for the admin's view.
      const note = (status: "ready" | "failed", info: { docId?: number; pageCount?: number; error?: string }) => {
        if (!user) return;
        const db = getRecordsDb();
        recordUpload(db, {
          userId: user.id,
          conversationId: conversationId as string,
          docId: info.docId ?? null,
          filename: originalFilename,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          pageCount: info.pageCount ?? null,
          status,
          error: info.error ?? null,
        });
        logActivity(
          db,
          activityFor(req, user, {
            kind: status === "ready" ? "upload_ready" : "upload_failed",
            status: status === "ready" ? "ok" : "error",
            message: info.error ?? null,
            resultPages: info.pageCount ?? null,
            details: { filename: originalFilename, sizeBytes: bytes.length },
          })
        );
      };

      const onStage = (event: UploadStage) => {
        if (event.stage === "reading" || event.stage === "indexing") {
          send({ type: "stage", stage: event.stage });
        } else if (event.stage === "running-ocr") {
          send({ type: "stage", stage: "running-ocr", page: event.page, totalPages: event.totalPages });
        } else if (event.stage === "ready") {
          note("ready", { docId: event.docId, pageCount: event.pageCount });
          send({ type: "ready", docId: event.docId, pageCount: event.pageCount });
        } else if (event.stage === "failed") {
          note("failed", { error: event.message });
          send({ type: "error", message: event.message });
        }
      };

      try {
        await indexUpload({ conversationId: conversationId as string, originalFilename, bytes, onStage });
      } catch (err) {
        console.error("[/api/uploads] indexing failed", { error: err });
        note("failed", { error: "indexing failed" });
        send({ type: "error", message: "Indexing failed. See the server log for details." });
      } finally {
        clearInterval(heartbeat);
        if (!clientGone) controller.close();
      }
    },
    cancel() {
      clientGone = true;
      clearInterval(heartbeat);
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
  const auth = await authorizeConversation(req, conversationId as string);
  if (!auth.ok) return auth.response;

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
  const auth = await authorizeConversation(req, conversationId as string);
  if (!auth.ok) return auth.response;
  const user = auth.user;

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
    if (user) {
      markUploadDeleted(getRecordsDb(), conversationId as string, docId);
      logActivity(getRecordsDb(), activityFor(req, user, { kind: "upload_deleted", details: { docId } }));
    }
    return Response.json({ ok: true });
  }

  await deleteConversationUploads(conversationId as string);
  if (user) {
    const db = getRecordsDb();
    markConversationUploadsDeleted(db, conversationId as string);
    releaseConversation(db, conversationId as string);
    logActivity(db, activityFor(req, user, { kind: "session_deleted" }));
  }
  return Response.json({ ok: true });
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
