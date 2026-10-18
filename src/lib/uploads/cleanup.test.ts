import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, replaceDocument } from "../../../scripts/indexer/store";

/** runRetentionCleanup, in isolation from the full upload pipeline: build an
 * index directly through store.ts (as pipeline.test.ts does for its own
 * assertions), so this doesn't need poppler/tesseract and always runs. */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-cleanup-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.OCR_CACHE_PATH = path.join(dir, "index", "ocr-cache.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
});

afterEach(async () => {
  const { _resetWritableDbForTests } = await import("./writableDb");
  _resetWritableDbForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.OCR_CACHE_PATH;
  delete process.env.UPLOADS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function textPage(layerText: string) {
  return {
    pageNo: 1,
    pageLabel: null,
    source: "text" as const,
    ocrReason: null,
    imageCoverage: 0,
    layerText,
    ocrText: null,
    error: null,
  };
}

describe("runRetentionCleanup", () => {
  it("deletes an expired document's rows and its file, keeps an unexpired one", async () => {
    const { getWritableDb } = await import("./writableDb");
    const { writeStoredFile, storedFileExists } = await import("./storage");
    const db = getWritableDb();

    insertUploadedDocument(db, {
      conversationId: "conv-old",
      originalFilename: "Old.pdf",
      storedFilename: "old-hash.pdf",
      sha256: "old-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-15T00:00:00.000Z", // long past
      pages: [textPage("old document text")],
    });
    insertUploadedDocument(db, {
      conversationId: "conv-fresh",
      originalFilename: "Fresh.pdf",
      storedFilename: "fresh-hash.pdf",
      sha256: "fresh-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", // far future
      pages: [textPage("fresh document text")],
    });
    await writeStoredFile("old-hash", Buffer.from("old"));
    await writeStoredFile("fresh-hash", Buffer.from("fresh"));

    const { runRetentionCleanup } = await import("./cleanup");
    const result = await runRetentionCleanup();

    expect(result).toEqual({ deletedDocuments: 1, deletedFiles: 1 });
    expect(await storedFileExists("old-hash")).toBe(false);
    expect(await storedFileExists("fresh-hash")).toBe(true);

    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    expect(uploadedDocuments(db, "conv-old")).toHaveLength(0);
    expect(uploadedDocuments(db, "conv-fresh")).toHaveLength(1);
  });

  it("never deletes a tender-corpus document (no expiry at all)", async () => {
    const { getWritableDb } = await import("./writableDb");
    const db = getWritableDb();
    replaceDocument(db, {
      filename: "tender.pdf",
      sha256: "tender-hash",
      sizeBytes: 1,
      pageCount: 1,
      ocrLang: "eng",
      settings: "v1",
      error: null,
      pages: [textPage("a real tender document")],
    });

    const { runRetentionCleanup } = await import("./cleanup");
    const result = await runRetentionCleanup();
    expect(result).toEqual({ deletedDocuments: 0, deletedFiles: 0 });

    const row = db.prepare("SELECT id FROM documents WHERE filename = 'tender.pdf'").get();
    expect(row).toBeDefined();
  });

  it("keeps the shared file when another document still references the same content", async () => {
    const { getWritableDb } = await import("./writableDb");
    const { writeStoredFile, storedFileExists } = await import("./storage");
    const db = getWritableDb();

    insertUploadedDocument(db, {
      conversationId: "conv-a",
      originalFilename: "A.pdf",
      storedFilename: "shared.pdf",
      sha256: "shared-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-15T00:00:00.000Z", // expired
      pages: [textPage("shared a")],
    });
    insertUploadedDocument(db, {
      conversationId: "conv-b",
      originalFilename: "B.pdf",
      storedFilename: "shared.pdf",
      sha256: "shared-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", // not expired
      pages: [textPage("shared b")],
    });
    await writeStoredFile("shared-hash", Buffer.from("shared content"));

    const { runRetentionCleanup } = await import("./cleanup");
    const result = await runRetentionCleanup();

    expect(result.deletedDocuments).toBe(1);
    expect(result.deletedFiles).toBe(0); // the file is still referenced by conv-b
    expect(await storedFileExists("shared-hash")).toBe(true);
  });

  it("is a no-op when nothing has expired", async () => {
    const { runRetentionCleanup } = await import("./cleanup");
    const result = await runRetentionCleanup();
    expect(result).toEqual({ deletedDocuments: 0, deletedFiles: 0 });
  });
});
