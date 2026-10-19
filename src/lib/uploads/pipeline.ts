import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, settingsKey } from "../../../scripts/indexer/config";
import { createLimiter } from "../../../scripts/indexer/exec";
import { extractDocument, sourceAfterOcr, ocrPage, type ExtractContext } from "../../../scripts/indexer/extract";
import { OcrCache } from "../../../scripts/indexer/ocrCache";
import {
  deleteConversationDocument,
  deleteConversationDocuments,
  insertUploadedDocument,
  sha256StillReferenced,
  upsertPageOcr,
  type ExtractedPage,
} from "../../../scripts/indexer/store";
import { retentionMs } from "./config";
import { deleteStoredFile, storedFileExists, writeStoredFile } from "./storage";
import { getWritableDb } from "./writableDb";

/**
 * Turns one uploaded PDF into searchable rows, in two passes (see
 * store.ts's insertUploadedDocument/upsertPageOcr): a fast one that writes
 * every page's text layer and plans which pages need OCR, and a slow one
 * that runs OCR for just those pages and joins each result in as it
 * finishes. `onStage` is called as the file moves through it, for the
 * upload route to turn into SSE events.
 */

export type UploadStage =
  | { stage: "reading" }
  | { stage: "indexing" }
  | { stage: "running-ocr"; page: number; totalPages: number }
  | { stage: "ready"; docId: number; pageCount: number }
  | { stage: "failed"; message: string };

// One shared OCR cache and concurrency limiter for the whole process --
// every upload (and every conversation) competes for the same CPU budget,
// the same way one `npm run index` run does.
let sharedCtx: { ocrCache: OcrCache; limit: ExtractContext["limit"] } | null = null;
function sharedContext(config: ReturnType<typeof loadConfig>) {
  if (!sharedCtx) {
    sharedCtx = {
      ocrCache: new OcrCache(config.ocrCachePath),
      limit: createLimiter(config.concurrency),
    };
  }
  return sharedCtx;
}

/** Test-only: drops the shared OCR cache/limiter so a test can point OCR_CACHE_PATH at a fresh directory. */
export function _resetSharedContextForTests(): void {
  sharedCtx?.ocrCache.close();
  sharedCtx = null;
}

export interface IndexUploadOptions {
  conversationId: string;
  originalFilename: string;
  bytes: Buffer;
  onStage: (event: UploadStage) => void;
}

export async function indexUpload(options: IndexUploadOptions): Promise<void> {
  const { conversationId, originalFilename, bytes, onStage } = options;
  const config = loadConfig();
  const { ocrCache, limit } = sharedContext(config);

  onStage({ stage: "reading" });

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!(await storedFileExists(sha256))) {
    await writeStoredFile(sha256, bytes);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "assay-upload-"));
  const stats = { ocrRun: 0, ocrCached: 0 };
  const ctx: ExtractContext = {
    config,
    limit,
    ocrCache,
    tempDir,
    log: () => {},
    stats,
    skipOcr: true,
  };

  try {
    const file = path.join(tempDir, "upload.pdf");
    await fs.writeFile(file, bytes);

    const extracted = await extractDocument(file, sha256, bytes.length, ctx);
    if (extracted.error) {
      onStage({ stage: "failed", message: extracted.error });
      return;
    }

    onStage({ stage: "indexing" });

    const now = new Date();
    const retention = retentionMs();
    const db = getWritableDb();
    const { docId, pendingPages } = insertUploadedDocument(db, {
      conversationId,
      originalFilename,
      storedFilename: `${sha256}.pdf`,
      sha256,
      sizeBytes: bytes.length,
      ocrLang: config.ocrLang,
      settings: settingsKey(config),
      uploadedAt: now.toISOString(),
      expiresAt: retention === null ? null : new Date(now.getTime() + retention).toISOString(),
      pages: extracted.pages,
    });

    if (pendingPages.length === 0) {
      onStage({ stage: "ready", docId, pageCount: extracted.pages.length });
      return;
    }

    // ocrReason per page, to decide the final source once OCR comes back
    // (mirrors extractDocument's own ocrReason -> source mapping).
    const reasonByPage = new Map(extracted.pages.map((p: ExtractedPage) => [p.pageNo, p.ocrReason]));

    let done = 0;
    await Promise.all(
      pendingPages.map(async ({ pageId, pageNo }) => {
        try {
          const ocrText = await ocrPage(file, sha256, pageNo, ctx);
          upsertPageOcr(db, docId, pageId, {
            source: sourceAfterOcr(reasonByPage.get(pageNo) ?? null),
            ocrText,
            error: null,
          });
        } catch (err) {
          upsertPageOcr(db, docId, pageId, {
            source: "failed",
            ocrText: null,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          done++;
          onStage({ stage: "running-ocr", page: done, totalPages: pendingPages.length });
        }
      })
    );

    onStage({ stage: "ready", docId, pageCount: extracted.pages.length });
  } catch (err) {
    onStage({ stage: "failed", message: err instanceof Error ? err.message : String(err) });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/** Removes a conversation's uploaded files and index rows, and -- for each -- the physical file and OCR cache entries if no other document still references that content. */
export async function deleteConversationUploads(conversationId: string): Promise<void> {
  const db = getWritableDb();
  const deleted = deleteConversationDocuments(db, conversationId);

  const config = loadConfig();
  const { ocrCache } = sharedContext(config);
  for (const doc of deleted) {
    if (sha256StillReferenced(db, doc.sha256, doc.id)) continue;
    await deleteStoredFile(doc.sha256);
    ocrCache.deleteForFile(doc.sha256);
  }
}

/**
 * Removes one uploaded document -- the per-file remove button, as opposed
 * to deleteConversationUploads' whole-conversation cascade: its index
 * rows, and the physical file and OCR cache entries too, unless another
 * document (in this or any other conversation) still references that same
 * content. Returns false (nothing deleted) if no such document exists in
 * that conversation, so the route can answer 404 instead of a false "ok".
 */
export async function deleteSingleUpload(conversationId: string, docId: number): Promise<boolean> {
  const db = getWritableDb();
  const deleted = deleteConversationDocument(db, conversationId, docId);
  if (!deleted) return false;

  const config = loadConfig();
  const { ocrCache } = sharedContext(config);
  if (!sha256StillReferenced(db, deleted.sha256, docId)) {
    await deleteStoredFile(deleted.sha256);
    ocrCache.deleteForFile(deleted.sha256);
  }

  // Same incremental reclaim runRetentionCleanup does after its own
  // deletes -- small batches, no long exclusive lock, so a live search
  // isn't held up by a remove button click.
  db.pragma("incremental_vacuum");
  return true;
}
