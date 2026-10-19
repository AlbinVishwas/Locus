import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtractedPage } from "./store";
import {
  clearLegacyUploadExpiryOnce,
  deleteConversationDocument,
  deleteConversationDocuments,
  expiredDocuments,
  insertUploadedDocument,
  openIndex,
  replaceDocument,
  sha256StillReferenced,
  uploadedDocuments,
  upsertPageOcr,
} from "./store";

/** Unit tests for the upload-oriented half of store.ts: insertUploadedDocument
 * (the fast, text-layer-only write), upsertPageOcr (pages joining in after),
 * and the conversation/expiry housekeeping queries. The CLI corpus path
 * (replaceDocument/deleteDocument) is exercised by pipeline.test.ts and
 * query.test.ts already. */

// Used by every fixture below that isn't testing expiry itself: far enough
// out that it's never in the past, so uploadedDocuments() (which excludes
// an expired document even before cleanup deletes it) always finds it.
const FAR_FUTURE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3650).toISOString();

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-upload-"));
  db = openIndex(path.join(dir, "search.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function pendingPage(pageNo: number, layerText = ""): ExtractedPage {
  return {
    pageNo,
    pageLabel: null,
    source: "pending-ocr",
    ocrReason: "no-text-layer",
    imageCoverage: 1,
    layerText,
    ocrText: null,
    error: null,
  };
}

function textPage(pageNo: number, layerText: string): ExtractedPage {
  return {
    pageNo,
    pageLabel: null,
    source: "text",
    ocrReason: null,
    imageCoverage: 0,
    layerText,
    ocrText: null,
    error: null,
  };
}

describe("insertUploadedDocument", () => {
  it("a document with no pages needing OCR is immediately 'ready'", () => {
    const { docId, pendingPages } = insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "Notice.pdf",
      storedFilename: "abc123.pdf",
      sha256: "abc123",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "hello world")],
    });
    expect(pendingPages).toEqual([]);
    const [doc] = uploadedDocuments(db, "conv-1");
    expect(doc).toMatchObject({ id: docId, status: "ready", originalFilename: "Notice.pdf" });
  });

  it("a document with a pending-ocr page starts 'indexing', and its text-layer pages are searchable right away", () => {
    const { pendingPages } = insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "Mixed.pdf",
      storedFilename: "def456.pdf",
      sha256: "def456",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "zebra giraffe"), pendingPage(2)],
    });
    expect(pendingPages).toHaveLength(1);
    expect(pendingPages[0].pageNo).toBe(2);

    const [doc] = uploadedDocuments(db, "conv-1");
    expect(doc.status).toBe("indexing");

    const row = db.prepare("SELECT body FROM texts WHERE page_id = (SELECT id FROM pages WHERE doc_id = ? AND page_no = 1)").get(doc.id) as { body: string } | undefined;
    expect(row?.body).toContain("zebra");
  });
});

describe("upsertPageOcr", () => {
  it("adds the OCR reading and flips status to 'ready' once every page resolves", () => {
    const { docId, pendingPages } = insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "Scan.pdf",
      storedFilename: "scan123.pdf",
      sha256: "scan123",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [pendingPage(1)],
    });

    expect(uploadedDocuments(db, "conv-1")[0].status).toBe("indexing");

    upsertPageOcr(db, docId, pendingPages[0].pageId, {
      source: "ocr",
      ocrText: "scanned flamingo text",
      error: null,
    });

    const doc = uploadedDocuments(db, "conv-1")[0];
    expect(doc.status).toBe("ready");

    const page = db.prepare("SELECT source FROM pages WHERE id = ?").get(pendingPages[0].pageId) as {
      source: string;
    };
    expect(page.source).toBe("ocr");

    const row = db.prepare("SELECT body FROM texts WHERE page_id = ? AND kind = 'ocr'").get(
      pendingPages[0].pageId
    ) as { body: string };
    expect(row.body).toContain("flamingo");
  });

  it("a doc stays 'indexing' while any page is still pending-ocr", () => {
    const { docId, pendingPages } = insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "TwoPending.pdf",
      storedFilename: "two123.pdf",
      sha256: "two123",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [pendingPage(1), pendingPage(2)],
    });

    upsertPageOcr(db, docId, pendingPages[0].pageId, { source: "ocr", ocrText: "first", error: null });
    expect(uploadedDocuments(db, "conv-1")[0].status).toBe("indexing");

    upsertPageOcr(db, docId, pendingPages[1].pageId, { source: "ocr", ocrText: "second", error: null });
    expect(uploadedDocuments(db, "conv-1")[0].status).toBe("ready");
  });

  it("marks the document 'failed' only when every page ends up unreadable", () => {
    const { docId, pendingPages } = insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "AllFailed.pdf",
      storedFilename: "fail123.pdf",
      sha256: "fail123",
      sizeBytes: 10,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [pendingPage(1)],
    });

    upsertPageOcr(db, docId, pendingPages[0].pageId, {
      source: "failed",
      ocrText: null,
      error: "tesseract timed out",
    });

    expect(uploadedDocuments(db, "conv-1")[0].status).toBe("failed");
  });
});

describe("conversation scoping and cleanup", () => {
  it("lists only one conversation's documents", () => {
    insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "A.pdf",
      storedFilename: "a.pdf",
      sha256: "a-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "alpha")],
    });
    insertUploadedDocument(db, {
      conversationId: "conv-b",
      originalFilename: "B.pdf",
      storedFilename: "b.pdf",
      sha256: "b-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "beta")],
    });

    expect(uploadedDocuments(db, "conv-a")).toHaveLength(1);
    expect(uploadedDocuments(db, "conv-b")).toHaveLength(1);
    expect(uploadedDocuments(db, "conv-a")[0].originalFilename).toBe("A.pdf");
  });

  it("deleteConversationDocuments removes only that conversation's rows", () => {
    insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "A.pdf",
      storedFilename: "a.pdf",
      sha256: "a-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "alpha")],
    });
    insertUploadedDocument(db, {
      conversationId: "conv-b",
      originalFilename: "B.pdf",
      storedFilename: "b.pdf",
      sha256: "b-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "beta")],
    });

    const beforeId = uploadedDocuments(db, "conv-a")[0].id;
    const deleted = deleteConversationDocuments(db, "conv-a");
    expect(deleted).toEqual([{ id: beforeId, sha256: "a-hash" }]);
    expect(uploadedDocuments(db, "conv-a")).toHaveLength(0);
    expect(uploadedDocuments(db, "conv-b")).toHaveLength(1);
  });

  it("expiredDocuments finds documents whose expiry has passed", () => {
    insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "Old.pdf",
      storedFilename: "old.pdf",
      sha256: "old-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      pages: [textPage(1, "old")],
    });
    insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "Fresh.pdf",
      storedFilename: "fresh.pdf",
      sha256: "fresh-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [textPage(1, "fresh")],
    });

    const expired = expiredDocuments(db, "2026-06-01T00:00:00.000Z");
    expect(expired.map((d) => d.filename)).toEqual(["old.pdf"]);
  });

  it("sha256StillReferenced is true only when another document shares the hash", () => {
    const { docId: idA } = insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "A.pdf",
      storedFilename: "shared.pdf",
      sha256: "shared-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "a")],
    });

    expect(sha256StillReferenced(db, "shared-hash", idA)).toBe(false);

    const { docId: idB } = insertUploadedDocument(db, {
      conversationId: "conv-b",
      originalFilename: "B.pdf",
      storedFilename: "shared.pdf",
      sha256: "shared-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "b")],
    });

    expect(sha256StillReferenced(db, "shared-hash", idA)).toBe(true);
    expect(sha256StillReferenced(db, "shared-hash", idB)).toBe(true);
  });

  it("deleteConversationDocument removes one file, scoped to its conversation", () => {
    const { docId: keepId } = insertUploadedDocument(db, {
      conversationId: "conv-remove",
      originalFilename: "Keep.pdf",
      storedFilename: "keep.pdf",
      sha256: "keep-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "keep")],
    });
    const { docId: removeId } = insertUploadedDocument(db, {
      conversationId: "conv-remove",
      originalFilename: "Remove.pdf",
      storedFilename: "remove.pdf",
      sha256: "remove-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "remove")],
    });

    const result = deleteConversationDocument(db, "conv-remove", removeId);
    expect(result).toEqual({ sha256: "remove-hash" });

    const remaining = uploadedDocuments(db, "conv-remove");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keepId);
  });

  it("deleteConversationDocument deletes nothing for the wrong conversationId", () => {
    const { docId } = insertUploadedDocument(db, {
      conversationId: "conv-owner",
      originalFilename: "Owned.pdf",
      storedFilename: "owned.pdf",
      sha256: "owned-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE,
      pages: [textPage(1, "owned")],
    });

    expect(deleteConversationDocument(db, "conv-not-the-owner", docId)).toBeNull();
    expect(uploadedDocuments(db, "conv-owner")).toHaveLength(1);
  });
});

describe("clearLegacyUploadExpiryOnce", () => {
  it("clears an existing upload's expires_at, left over from the old fixed-retention default", () => {
    insertUploadedDocument(db, {
      conversationId: "conv-legacy",
      originalFilename: "Legacy.pdf",
      storedFilename: "legacy.pdf",
      sha256: "legacy-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-15T00:00:00.000Z", // written under the old, now-gone 14-day default
      pages: [textPage(1, "legacy")],
    });

    clearLegacyUploadExpiryOnce(db);

    expect(uploadedDocuments(db, "conv-legacy")[0].expiresAt).toBeNull();
  });

  it("never touches the tender corpus (conversation_id IS NULL already has no expiry)", () => {
    replaceDocument(db, {
      filename: "tender.pdf",
      sha256: "tender-hash",
      sizeBytes: 1,
      pageCount: 1,
      ocrLang: "eng",
      settings: "v1",
      error: null,
      pages: [textPage(1, "a real tender document")],
    });

    clearLegacyUploadExpiryOnce(db);

    const row = db.prepare("SELECT expires_at FROM documents WHERE filename = 'tender.pdf'").get() as {
      expires_at: string | null;
    };
    expect(row.expires_at).toBeNull();
  });

  it("only runs once: a real expiry set after the migration already ran survives a second call", () => {
    clearLegacyUploadExpiryOnce(db); // first call: nothing to clear yet, just marks it done

    insertUploadedDocument(db, {
      conversationId: "conv-after-migration",
      originalFilename: "AfterMigration.pdf",
      storedFilename: "after.pdf",
      sha256: "after-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: FAR_FUTURE, // a real, freshly-configured expiry
      pages: [textPage(1, "after")],
    });

    clearLegacyUploadExpiryOnce(db); // must be a no-op now

    expect(uploadedDocuments(db, "conv-after-migration")[0].expiresAt).toBe(FAR_FUTURE);
  });
});
