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
});
