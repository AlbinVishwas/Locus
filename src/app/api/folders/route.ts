import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { markUploadDeleted } from "@/lib/records/ownership";
import { userUploadBytes } from "@/lib/records/users";
import { activityFor, authorizeConversation, requireUser } from "@/lib/session";
import { indexPath } from "@/lib/search/indexDb";
import { maxFolderFileBytes, maxFolderFiles, storageCapBytes, uploadParallel, uploadsEnabled } from "@/lib/uploads/config";
import { folderSessionId } from "@/lib/uploads/folders";
import { deleteSingleUpload } from "@/lib/uploads/pipeline";
import { measureStorageUsage } from "@/lib/uploads/storage";
import { sanitizeOriginalFilename } from "@/lib/uploads/validate";
import { getWritableDb } from "@/lib/uploads/writableDb";
import { userUploadLimitBytes } from "@/lib/users/mode";
import path from "node:path";
import { uploadedDocuments } from "../../../../scripts/indexer/store";

// better-sqlite3 is a native Node module.
export const runtime = "nodejs";

/**
 * Picked folders. A folder the user picks on their own device is searched as
 * one private upload session of its own (see lib/uploads/folders.ts), so it
 * uses the same pipeline, ownership rules and limits as any upload; this route
 * only works out which session that is and which of the folder's files still
 * need sending.
 */

const ADMIN_HINT = "Ask the administrator to add it as a library folder instead.";
const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${Math.round(bytes / (1024 * 1024))} MB`);

/** What a pick may contain, so the browser can say so before it reads anything. */
export async function GET(req: Request) {
  const gate = await requireUser(req);
  if (!gate.ok) return gate.response;
  return Response.json(
    { enabled: uploadsEnabled(), maxFiles: maxFolderFiles(), maxFileBytes: maxFolderFileBytes(), uploadParallel: uploadParallel() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

interface PickedFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * { name, files: [{ path, size, sha256 }] } -> { conversationId, total, present, upload: [paths] }.
 * Brings the folder's index in line with the pick: files already indexed
 * with the same content stay, files that changed or are gone are removed,
 * and the rest are listed for the browser to upload.
 */
export async function POST(req: Request) {
  if (!uploadsEnabled()) {
    return new Response("Uploads are disabled. Set LOCUS_ENABLE_UPLOADS=true only for a trusted local deployment.", { status: 403 });
  }
  let body: { name?: unknown; files?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const name = typeof body.name === "string" ? sanitizeOriginalFilename(body.name) : "";
  if (!name || !Array.isArray(body.files)) return new Response("`name` and `files` are required", { status: 400 });

  const maxFiles = maxFolderFiles();
  const maxFile = maxFolderFileBytes();
  if (body.files.length === 0) return new Response("There are no PDFs in that folder.", { status: 400 });
  if (body.files.length > maxFiles) {
    return new Response(`That folder has ${body.files.length} PDFs; one pick takes at most ${maxFiles}. Pick a smaller folder. ${ADMIN_HINT}`, { status: 413 });
  }
  const files: PickedFile[] = [];
  const seen = new Set<string>();
  for (const f of body.files as Array<Record<string, unknown>>) {
    if (typeof f?.path !== "string" || typeof f.size !== "number" || typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isFinite(f.size) || f.size < 0) {
      return new Response("Each file needs a `path`, a `size` and a `sha256`", { status: 400 });
    }
    const p = sanitizeOriginalFilename(f.path);
    if (seen.has(p)) continue;
    seen.add(p);
    if (f.size > maxFile) {
      return new Response(`${p} is ${mb(f.size)}; the limit for one file is ${mb(maxFile)}.`, { status: 413 });
    }
    files.push({ path: p, size: f.size, sha256: f.sha256 });
  }

  const gate = await requireUser(req);
  if (!gate.ok) return gate.response;
  const conversationId = folderSessionId(gate.user?.id ?? null, name);
  const auth = await authorizeConversation(req, conversationId);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const db = getWritableDb();
  const existing = uploadedDocuments(db, conversationId);
  const wanted = new Map(files.map((f) => [f.path, f.sha256]));
  const kept = new Set<string>();
  let removed = 0;
  for (const doc of existing) {
    const rel = doc.originalFilename ?? "";
    const same = wanted.get(rel) === doc.sha256 && doc.status !== "failed" && !kept.has(rel);
    if (same) {
      kept.add(rel);
      continue;
    }
    if (await deleteSingleUpload(conversationId, doc.id)) {
      removed++;
      if (user) markUploadDeleted(getRecordsDb(), conversationId, doc.id);
    }
  }
  const upload = files.filter((f) => !kept.has(f.path));

  // The same two caps an ordinary upload meets, checked for the whole batch up front so the pick fails before anything is sent.
  const incoming = upload.reduce((sum, f) => sum + f.size, 0);
  if (user) {
    const used = userUploadBytes(getRecordsDb(), user.id);
    const limit = userUploadLimitBytes();
    if (used + incoming > limit) {
      logActivity(getRecordsDb(), activityFor(req, user, { kind: "upload_failed", status: "refused", message: "folder pick over the per-user upload limit", details: { sizeBytes: incoming } }));
      return new Response(`This folder needs ${mb(incoming)} and you've used ${mb(used)} of your ${mb(limit)} upload limit. Pick a smaller folder or remove some files. ${ADMIN_HINT}`, { status: 507 });
    }
  }
  const usage = await measureStorageUsage(path.dirname(indexPath()));
  const cap = storageCapBytes();
  if (usage.totalBytes + incoming > cap) {
    return new Response(`Storage is full: this folder needs ${mb(incoming)} and ${mb(usage.totalBytes)} of ${mb(cap)} is used. ${ADMIN_HINT}`, { status: 507 });
  }

  return Response.json(
    { conversationId, total: files.length, present: kept.size, removed, upload: upload.map((f) => f.path) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
