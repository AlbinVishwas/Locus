import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixturePdf } from "../../../scripts/indexer/fixtures";
import { search } from "../search/query";

/**
 * End to end through the real pipeline (poppler + tesseract, like
 * scripts/indexer/pipeline.test.ts), but the upload path: a page with a
 * text layer is searchable before OCR runs at all, a pending-ocr page
 * joins in afterwards, and deleting the conversation removes everything.
 *
 * Needs `brew install poppler tesseract` -- SKIP_OCR_TESTS=1 skips this on
 * purpose, same convention as the CLI pipeline tests.
 */

const skip = process.env.SKIP_OCR_TESTS === "1";

function assertToolsInstalled() {
  const missing = ["pdfinfo", "pdftotext", "pdftoppm", "pdfimages", "tesseract"].filter((tool) => {
    try {
      execFileSync("which", [tool], { stdio: "ignore" });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(`Needs ${missing.join(", ")} (brew install poppler tesseract). Set SKIP_OCR_TESTS=1 to skip.`);
  }
}

let dir: string;

beforeEach(() => {
  if (skip) return;
  assertToolsInstalled();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-upload-pipeline-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.OCR_CACHE_PATH = path.join(dir, "index", "ocr-cache.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
  process.env.OCR_PAGES = "auto"; // only pages that actually need it, so pendingPages is small and deliberate
});

afterEach(async () => {
  if (skip) return;
  const { _resetWritableDbForTests } = await import("./writableDb");
  const { _resetSharedContextForTests } = await import("./pipeline");
  _resetWritableDbForTests();
  _resetSharedContextForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.OCR_CACHE_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.OCR_PAGES;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(skip)("indexUpload", () => {
  it("a text-layer page is searchable before OCR runs, and the OCR page joins in afterwards", async () => {
    const { indexUpload } = await import("./pipeline");
    const file = path.join(dir, "mixed.pdf");
    await writeFixturePdf(
      file,
      [{ lines: ["giraffe appears in the real typed text layer of this page"] }, { imageWords: "ZEBRA STAMPEDE" }],
      { workDir: dir }
    );
    const bytes = fs.readFileSync(file);

    const stages: string[] = [];
    let readySeen = false;
    await indexUpload({
      conversationId: "conv-1",
      originalFilename: "Mixed.pdf",
      bytes,
      onStage: (e) => {
        stages.push(e.stage);
        if (e.stage === "ready") readySeen = true;
      },
    });

    expect(readySeen).toBe(true);
    expect(stages).toContain("reading");
    expect(stages).toContain("indexing");
    expect(stages).toContain("running-ocr");

    const { getIndexDb } = await import("../search/indexDb");
    const textHit = search(getIndexDb(), "giraffe", { mode: "exact", offset: 0, limit: 10, scope: "conv-1" });
    expect(textHit.hits).toHaveLength(1);

    const ocrHit = search(getIndexDb(), "zebra", { mode: "exact", offset: 0, limit: 10, scope: "conv-1" });
    expect(ocrHit.hits).toHaveLength(1);
    expect(ocrHit.hits[0].ocrOnly).toBe(true);
  });

  it("a conversation's search never sees another conversation's upload", async () => {
    const { indexUpload } = await import("./pipeline");
    const file = path.join(dir, "private.pdf");
    await writeFixturePdf(file, [{ lines: ["confidential wombat figures"] }], { workDir: dir });

    await indexUpload({
      conversationId: "conv-private",
      originalFilename: "Private.pdf",
      bytes: fs.readFileSync(file),
      onStage: () => {},
    });

    const { getIndexDb } = await import("../search/indexDb");
    const wrongScope = search(getIndexDb(), "wombat", {
      mode: "exact",
      offset: 0,
      limit: 10,
      scope: "conv-other",
    });
    expect(wrongScope.hits).toHaveLength(0);

    const rightScope = search(getIndexDb(), "wombat", {
      mode: "exact",
      offset: 0,
      limit: 10,
      scope: "conv-private",
    });
    expect(rightScope.hits).toHaveLength(1);
  });

  it("deleteConversationUploads removes the file, the index rows, and search sees nothing afterwards", async () => {
    const { indexUpload, deleteConversationUploads } = await import("./pipeline");
    const { storedFileExists } = await import("./storage");
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    const { getWritableDb } = await import("./writableDb");

    const file = path.join(dir, "toDelete.pdf");
    await writeFixturePdf(file, [{ lines: ["panther quarry notice"] }], { workDir: dir });
    let sha256 = "";
    await indexUpload({
      conversationId: "conv-delete-me",
      originalFilename: "ToDelete.pdf",
      bytes: fs.readFileSync(file),
      onStage: () => {},
    });
    sha256 = uploadedDocuments(getWritableDb(), "conv-delete-me")[0].sha256;
    expect(await storedFileExists(sha256)).toBe(true);

    await deleteConversationUploads("conv-delete-me");

    expect(uploadedDocuments(getWritableDb(), "conv-delete-me")).toHaveLength(0);
    expect(await storedFileExists(sha256)).toBe(false);

    const { getIndexDb } = await import("../search/indexDb");
    const afterDelete = search(getIndexDb(), "panther", {
      mode: "exact",
      offset: 0,
      limit: 10,
      scope: "conv-delete-me",
    });
    expect(afterDelete.hits).toHaveLength(0);
  });

  it("deleting one conversation keeps a byte-identical upload another conversation still references", async () => {
    const { indexUpload, deleteConversationUploads } = await import("./pipeline");
    const { storedFileExists } = await import("./storage");

    const file = path.join(dir, "shared.pdf");
    await writeFixturePdf(file, [{ lines: ["shared armadillo notice"] }], { workDir: dir });
    const bytes = fs.readFileSync(file);

    await indexUpload({ conversationId: "conv-x", originalFilename: "Shared.pdf", bytes, onStage: () => {} });
    await indexUpload({ conversationId: "conv-y", originalFilename: "Shared.pdf", bytes, onStage: () => {} });

    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(await storedFileExists(sha256)).toBe(true);

    await deleteConversationUploads("conv-x");
    // conv-y's row still points at this content -- the file must survive.
    expect(await storedFileExists(sha256)).toBe(true);

    await deleteConversationUploads("conv-y");
    expect(await storedFileExists(sha256)).toBe(false);
  });

  it("isn't given an expiry at all by default (LOCUS_RETENTION_DAYS unset)", async () => {
    const { indexUpload } = await import("./pipeline");
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    const { getWritableDb } = await import("./writableDb");

    const file = path.join(dir, "never-expires.pdf");
    await writeFixturePdf(file, [{ lines: ["lasting otter record"] }], { workDir: dir });
    await indexUpload({
      conversationId: "conv-no-retention",
      originalFilename: "NeverExpires.pdf",
      bytes: fs.readFileSync(file),
      onStage: () => {},
    });

    const [doc] = uploadedDocuments(getWritableDb(), "conv-no-retention");
    expect(doc.expiresAt).toBeNull();
  });

  it("is given a real future expiry when LOCUS_RETENTION_DAYS is set", async () => {
    process.env.LOCUS_RETENTION_DAYS = "14";
    try {
      const { indexUpload } = await import("./pipeline");
      const { uploadedDocuments } = await import("../../../scripts/indexer/store");
      const { getWritableDb } = await import("./writableDb");

      const file = path.join(dir, "expires.pdf");
      await writeFixturePdf(file, [{ lines: ["temporary otter record"] }], { workDir: dir });
      const before = Date.now();
      await indexUpload({
        conversationId: "conv-with-retention",
        originalFilename: "Expires.pdf",
        bytes: fs.readFileSync(file),
        onStage: () => {},
      });

      const [doc] = uploadedDocuments(getWritableDb(), "conv-with-retention");
      expect(doc.expiresAt).not.toBeNull();
      const expiresAt = new Date(doc.expiresAt!).getTime();
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
      // Within a few seconds of "uploaded just now + 14 days", not an
      // exact match -- the upload itself takes real wall-clock time.
      expect(expiresAt).toBeGreaterThan(before + fourteenDaysMs - 5000);
      expect(expiresAt).toBeLessThan(before + fourteenDaysMs + 60_000);
    } finally {
      delete process.env.LOCUS_RETENTION_DAYS;
    }
  });

  it("deleteSingleUpload removes just the one file, keeping a sibling file in the same conversation", async () => {
    const { indexUpload, deleteSingleUpload } = await import("./pipeline");
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    const { getWritableDb } = await import("./writableDb");
    const { storedFileExists } = await import("./storage");

    const fileA = path.join(dir, "keep.pdf");
    const fileB = path.join(dir, "remove.pdf");
    await writeFixturePdf(fileA, [{ lines: ["keep this heron notice"] }], { workDir: dir });
    await writeFixturePdf(fileB, [{ lines: ["remove this falcon notice"] }], { workDir: dir });

    await indexUpload({
      conversationId: "conv-remove-one",
      originalFilename: "Keep.pdf",
      bytes: fs.readFileSync(fileA),
      onStage: () => {},
    });
    await indexUpload({
      conversationId: "conv-remove-one",
      originalFilename: "Remove.pdf",
      bytes: fs.readFileSync(fileB),
      onStage: () => {},
    });

    const db = getWritableDb();
    const docs = uploadedDocuments(db, "conv-remove-one");
    expect(docs).toHaveLength(2);
    const toRemove = docs.find((d) => d.originalFilename === "Remove.pdf")!;
    const toKeep = docs.find((d) => d.originalFilename === "Keep.pdf")!;

    const removed = await deleteSingleUpload("conv-remove-one", toRemove.id);
    expect(removed).toBe(true);

    const remaining = uploadedDocuments(db, "conv-remove-one");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(toKeep.id);

    expect(await storedFileExists(toRemove.sha256)).toBe(false);
    expect(await storedFileExists(toKeep.sha256)).toBe(true);

    const { getIndexDb } = await import("../search/indexDb");
    const removedHit = search(getIndexDb(), "falcon", {
      mode: "exact",
      offset: 0,
      limit: 10,
      scope: "conv-remove-one",
    });
    expect(removedHit.hits).toHaveLength(0);
    const keptHit = search(getIndexDb(), "heron", {
      mode: "exact",
      offset: 0,
      limit: 10,
      scope: "conv-remove-one",
    });
    expect(keptHit.hits).toHaveLength(1);
  });

  it("deleteSingleUpload is scoped to the given conversation: wrong conversationId deletes nothing", async () => {
    const { indexUpload, deleteSingleUpload } = await import("./pipeline");
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    const { getWritableDb } = await import("./writableDb");

    const file = path.join(dir, "owned.pdf");
    await writeFixturePdf(file, [{ lines: ["owned by conv-owner only"] }], { workDir: dir });
    await indexUpload({
      conversationId: "conv-owner",
      originalFilename: "Owned.pdf",
      bytes: fs.readFileSync(file),
      onStage: () => {},
    });
    const [doc] = uploadedDocuments(getWritableDb(), "conv-owner");

    const removed = await deleteSingleUpload("conv-not-the-owner", doc.id);
    expect(removed).toBe(false);
    expect(uploadedDocuments(getWritableDb(), "conv-owner")).toHaveLength(1);
  });

  it("deleteSingleUpload keeps OCR cache entries another file still uses, and drops them once nothing does", async () => {
    const { indexUpload, deleteSingleUpload } = await import("./pipeline");
    const { uploadedDocuments } = await import("../../../scripts/indexer/store");
    const { getWritableDb } = await import("./writableDb");
    const { storedFileExists } = await import("./storage");
    const Database = (await import("better-sqlite3")).default;
    const { createHash } = await import("node:crypto");

    // An image-only page forces a real OCR pass, so this exercises the
    // actual cache -- not just the search-index rows.
    const file = path.join(dir, "shared-ocr.pdf");
    await writeFixturePdf(file, [{ imageWords: "PANGOLIN SURVEY" }], { workDir: dir });
    const bytes = fs.readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await indexUpload({ conversationId: "conv-ocr-a", originalFilename: "Shared.pdf", bytes, onStage: () => {} });
    await indexUpload({ conversationId: "conv-ocr-b", originalFilename: "Shared.pdf", bytes, onStage: () => {} });

    // Read the OCR cache file directly, the way _resetSharedContextForTests
    // doesn't need to -- this test only needs to know whether rows for
    // this sha256 exist, not go through the cache's own get()/put() API.
    const readCacheRowCount = () => {
      const db = new Database(process.env.OCR_CACHE_PATH!, { readonly: true });
      try {
        return db.prepare("SELECT COUNT(*) FROM ocr WHERE sha256 = ?").pluck().get(sha256) as number;
      } finally {
        db.close();
      }
    };
    expect(readCacheRowCount()).toBeGreaterThan(0);

    const docA = uploadedDocuments(getWritableDb(), "conv-ocr-a")[0];
    await deleteSingleUpload("conv-ocr-a", docA.id);

    // conv-b's upload shares this exact content -- the file and its OCR
    // cache entries must both survive.
    expect(await storedFileExists(sha256)).toBe(true);
    expect(readCacheRowCount()).toBeGreaterThan(0);

    const docB = uploadedDocuments(getWritableDb(), "conv-ocr-b")[0];
    await deleteSingleUpload("conv-ocr-b", docB.id);

    expect(await storedFileExists(sha256)).toBe(false);
    expect(readCacheRowCount()).toBe(0);
  });
});
