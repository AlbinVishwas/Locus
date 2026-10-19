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

  it("with LOCUS_RETENTION_DAYS unset, a file uploaded 30+ days ago never expires -- not now, not on a later (hourly-equivalent) run", async () => {
    const { getWritableDb } = await import("./writableDb");
    const { writeStoredFile, storedFileExists } = await import("./storage");
    const db = getWritableDb();

    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    insertUploadedDocument(db, {
      conversationId: "conv-ancient",
      originalFilename: "Ancient.pdf",
      storedFilename: "ancient-hash.pdf",
      sha256: "ancient-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: thirtyFiveDaysAgo,
      expiresAt: null, // what pipeline.ts now writes when retention is off
      pages: [textPage("ancient but permanent document")],
    });
    await writeStoredFile("ancient-hash", Buffer.from("ancient"));

    const { runRetentionCleanup } = await import("./cleanup");
    const { search } = await import("../search/query");
    const { getIndexDb } = await import("../search/indexDb");

    // Still searchable before any cleanup runs at all.
    expect(
      search(getIndexDb(), "permanent", { mode: "exact", offset: 0, limit: 10, scope: "conv-ancient" }).hits
    ).toHaveLength(1);

    const firstRun = await runRetentionCleanup();
    expect(firstRun).toEqual({ deletedDocuments: 0, deletedFiles: 0 });

    // A second run -- standing in for the next hourly sweep -- still
    // leaves it alone; this isn't a one-time grace period.
    const secondRun = await runRetentionCleanup();
    expect(secondRun).toEqual({ deletedDocuments: 0, deletedFiles: 0 });

    expect(await storedFileExists("ancient-hash")).toBe(true);
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    expect(uploadedDocuments(db, "conv-ancient")).toHaveLength(1);
  });

  it("setting LOCUS_RETENTION_DAYS still expires a file correctly", async () => {
    process.env.LOCUS_RETENTION_DAYS = "14";
    try {
      const { getWritableDb } = await import("./writableDb");
      const { writeStoredFile, storedFileExists } = await import("./storage");
      const { retentionMs } = await import("./config");
      const db = getWritableDb();

      // Uploaded (per config at the time) 15 days ago with a 14-day
      // retention window -- one day past its expiry.
      const fifteenDaysAgo = Date.now() - 15 * 24 * 60 * 60 * 1000;
      insertUploadedDocument(db, {
        conversationId: "conv-configured-expiry",
        originalFilename: "Configured.pdf",
        storedFilename: "configured-hash.pdf",
        sha256: "configured-hash",
        sizeBytes: 1,
        ocrLang: "eng",
        settings: "v1",
        uploadedAt: new Date(fifteenDaysAgo).toISOString(),
        expiresAt: new Date(fifteenDaysAgo + retentionMs()!).toISOString(),
        pages: [textPage("configured expiry document")],
      });
      await writeStoredFile("configured-hash", Buffer.from("configured"));

      const { runRetentionCleanup } = await import("./cleanup");
      const result = await runRetentionCleanup();

      expect(result).toEqual({ deletedDocuments: 1, deletedFiles: 1 });
      expect(await storedFileExists("configured-hash")).toBe(false);
    } finally {
      delete process.env.LOCUS_RETENTION_DAYS;
    }
  });
});

describe("startRetentionSchedule / ensureRetentionScheduleStarted", () => {
  afterEach(async () => {
    const { _resetRetentionScheduleForTests } = await import("./cleanup");
    _resetRetentionScheduleForTests();
    delete process.env.LOCUS_ENABLE_UPLOADS;
  });

  it("deletes a file already past its (explicitly set) expiry the moment the schedule starts, with no upload happening", async () => {
    const { getWritableDb } = await import("./writableDb");
    const { storedFileExists, writeStoredFile } = await import("./storage");
    const db = getWritableDb();

    insertUploadedDocument(db, {
      conversationId: "conv-stale",
      originalFilename: "Stale.pdf",
      storedFilename: "stale-hash.pdf",
      sha256: "stale-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-15T00:00:00.000Z", // long past, as if the server has been off since
      pages: [textPage("stale document text")],
    });
    await writeStoredFile("stale-hash", Buffer.from("stale"));

    process.env.LOCUS_ENABLE_UPLOADS = "true";
    const { ensureRetentionScheduleStarted } = await import("./cleanup");
    // This is the exact entry point layout.tsx and the uploads route call
    // -- there's no separate "run once at start" step to invoke here, by
    // design: starting the schedule and running it once immediately are
    // the same call (see startRetentionSchedule).
    ensureRetentionScheduleStarted();

    // runRetentionCleanup runs fire-and-forget inside the schedule (see
    // startRetentionSchedule); give its microtasks a turn to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await storedFileExists("stale-hash")).toBe(false);
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    expect(uploadedDocuments(db, "conv-stale")).toHaveLength(0);
  });
});
