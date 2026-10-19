import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFixturePdf } from "../../../../scripts/indexer/fixtures";
import { insertUploadedDocument } from "../../../../scripts/indexer/store";
import { DELETE, GET, POST } from "./route";

/**
 * HTTP-level validation for /api/uploads: the checks a real request can
 * actually hit (size, PDF magic bytes, per-conversation count, the
 * storage cap) before indexing is ever attempted, so every test here
 * except the path-traversal one short-circuits before the real pipeline
 * (poppler/tesseract) ever runs. That one test needs them -- same
 * SKIP_OCR_TESTS=1 convention as scripts/indexer/pipeline.test.ts and
 * src/lib/uploads/pipeline.test.ts -- since it has to let a real upload
 * reach "ready" to check what actually landed on disk and in the index.
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";

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

function pdfBytes(sizeBytes = 100): ArrayBuffer {
  const bytes = new Uint8Array(sizeBytes);
  const header = new TextEncoder().encode("%PDF-1.7\n");
  bytes.set(header);
  return bytes.buffer as ArrayBuffer;
}

function postForm(fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return POST(new Request("http://localhost/api/uploads", { method: "POST", body: form }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-uploads-route-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.OCR_CACHE_PATH = path.join(dir, "index", "ocr-cache.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
  process.env.LOCUS_ENABLE_UPLOADS = "true";
});

afterEach(async () => {
  const { _resetWritableDbForTests } = await import("@/lib/uploads/writableDb");
  _resetWritableDbForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.OCR_CACHE_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.LOCUS_ENABLE_UPLOADS;
  delete process.env.MAX_UPLOAD_FILE_BYTES;
  delete process.env.MAX_FILES_PER_CONVERSATION;
  delete process.env.STORAGE_CAP_BYTES;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/uploads", () => {
  it("refuses every upload when disabled (production, flag unset)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.LOCUS_ENABLE_UPLOADS;
    try {
      const res = await postForm({
        conversationId: "c1",
        file: new File([pdfBytes()], "a.pdf", { type: "application/pdf" }),
      });
      expect(res.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("requires a conversationId", async () => {
    const res = await postForm({ file: new File([pdfBytes()], "a.pdf") });
    expect(res.status).toBe(400);
  });

  it("requires a file", async () => {
    const res = await postForm({ conversationId: "c1" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-PDF, even one named to end in .pdf", async () => {
    const res = await postForm({
      conversationId: "c1",
      file: new File([new TextEncoder().encode("not a pdf")], "fake.pdf"),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("PDF");
  });

  it.skipIf(skipOcr)("accepts a path-traversal-style filename as a display name without it ever becoming a path", async () => {
    assertToolsInstalled();
    const realPdf = path.join(dir, "real.pdf");
    await writeFixturePdf(realPdf, [{ lines: ["a real page of text"] }], { workDir: dir });

    const malicious = "../../../../etc/passwd.pdf";
    const res = await postForm({
      conversationId: "c-traversal",
      file: new File([fs.readFileSync(realPdf)], malicious, { type: "application/pdf" }),
    });
    // Collect to the end so the file (content-addressed, not named after
    // the upload) actually gets written and indexed.
    const text = await res.text();
    for (const line of text.split("\n\n")) {
      if (line.includes('"type":"error"')) throw new Error(`Upload failed: ${line}`);
    }

    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    const { uploadedDocuments } = await import("../../../../scripts/indexer/store");
    const [doc] = uploadedDocuments(getWritableDb(), "c-traversal");
    expect(doc.originalFilename).toBe(malicious); // kept verbatim for display
    expect(doc.filename).not.toContain(".."); // never used to build a path
    expect(doc.filename).toMatch(/^[0-9a-f]{64}\.pdf$/); // content-addressed instead

    const { storedFileExists } = await import("@/lib/uploads/storage");
    expect(await storedFileExists(doc.sha256)).toBe(true);
  });

  it("rejects a file over MAX_UPLOAD_FILE_BYTES", async () => {
    process.env.MAX_UPLOAD_FILE_BYTES = "500";
    const res = await postForm({
      conversationId: "c1",
      file: new File([pdfBytes(1000)], "big.pdf", { type: "application/pdf" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("limit");
  });

  it("refuses a file once the conversation is at its file-count limit", async () => {
    process.env.MAX_FILES_PER_CONVERSATION = "1";
    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    insertUploadedDocument(getWritableDb(), {
      conversationId: "c-full",
      originalFilename: "existing.pdf",
      storedFilename: "existing.pdf",
      sha256: "existing",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      pages: [],
    });

    const res = await postForm({
      conversationId: "c-full",
      file: new File([pdfBytes()], "new.pdf", { type: "application/pdf" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("limit");
  });

  it("refuses a file that would push total storage over the cap", async () => {
    process.env.STORAGE_CAP_BYTES = "50"; // smaller than any real upload
    const res = await postForm({
      conversationId: "c-cap",
      file: new File([pdfBytes(200)], "too-big-for-the-cap.pdf", { type: "application/pdf" }),
    });
    expect(res.status).toBe(507);
    const body = await res.text();
    expect(body).toContain("Storage is full");
  });
});

describe("GET /api/uploads", () => {
  it("lists a conversation's documents", async () => {
    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    insertUploadedDocument(getWritableDb(), {
      conversationId: "c-list",
      originalFilename: "Listed.pdf",
      storedFilename: "listed.pdf",
      sha256: "listed",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      pages: [],
    });

    const res = await GET(new Request("http://localhost/api/uploads?conversationId=c-list"));
    const body = (await res.json()) as { documents: unknown[] };
    expect(body.documents).toHaveLength(1);
  });

  it("requires a conversationId", async () => {
    const res = await GET(new Request("http://localhost/api/uploads"));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/uploads", () => {
  it("removes a conversation's documents", async () => {
    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    insertUploadedDocument(getWritableDb(), {
      conversationId: "c-del",
      originalFilename: "ToDelete.pdf",
      storedFilename: "todelete.pdf",
      sha256: "todelete",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      pages: [],
    });

    const res = await DELETE(new Request("http://localhost/api/uploads?conversationId=c-del", { method: "DELETE" }));
    expect(res.status).toBe(200);

    const after = await GET(new Request("http://localhost/api/uploads?conversationId=c-del"));
    const body = (await after.json()) as { documents: unknown[] };
    expect(body.documents).toHaveLength(0);
  });

  it("with a docId, removes just that one file", async () => {
    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    const db = getWritableDb();
    insertUploadedDocument(db, {
      conversationId: "c-del-one",
      originalFilename: "Keep.pdf",
      storedFilename: "keep.pdf",
      sha256: "keep-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: null,
      pages: [],
    });
    insertUploadedDocument(db, {
      conversationId: "c-del-one",
      originalFilename: "Remove.pdf",
      storedFilename: "remove.pdf",
      sha256: "remove-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: null,
      pages: [],
    });

    const { uploadedDocuments } = await import("../../../../scripts/indexer/store");
    const toRemove = uploadedDocuments(db, "c-del-one").find((d) => d.originalFilename === "Remove.pdf")!;

    const res = await DELETE(
      new Request(`http://localhost/api/uploads?conversationId=c-del-one&docId=${toRemove.id}`, {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(200);

    const remaining = uploadedDocuments(db, "c-del-one");
    expect(remaining).toHaveLength(1);
    expect(remaining[0].originalFilename).toBe("Keep.pdf");
  });

  it("404s for a docId that doesn't belong to that conversation", async () => {
    const { getWritableDb } = await import("@/lib/uploads/writableDb");
    const db = getWritableDb();
    insertUploadedDocument(db, {
      conversationId: "c-owner",
      originalFilename: "Owned.pdf",
      storedFilename: "owned.pdf",
      sha256: "owned-hash",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: new Date().toISOString(),
      expiresAt: null,
      pages: [],
    });
    const { uploadedDocuments } = await import("../../../../scripts/indexer/store");
    const doc = uploadedDocuments(db, "c-owner")[0];

    const res = await DELETE(
      new Request(`http://localhost/api/uploads?conversationId=c-not-the-owner&docId=${doc.id}`, {
        method: "DELETE",
      })
    );
    expect(res.status).toBe(404);
    expect(uploadedDocuments(db, "c-owner")).toHaveLength(1);
  });

  it("400s for a non-numeric docId", async () => {
    const res = await DELETE(
      new Request("http://localhost/api/uploads?conversationId=c-del&docId=not-a-number", { method: "DELETE" })
    );
    expect(res.status).toBe(400);
  });
});
