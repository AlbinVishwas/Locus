import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUploadedDocument } from "../../../../scripts/indexer/store";
import { DELETE, GET, POST } from "./route";

/**
 * HTTP-level validation for /api/uploads: the checks a real request can
 * actually hit (size, PDF magic bytes, per-conversation count, the
 * storage cap) before indexing is ever attempted. The indexing pipeline
 * itself is covered by src/lib/uploads/pipeline.test.ts (needs real
 * poppler/tesseract); this file doesn't, so it always runs.
 */

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
  process.env.ASSAY_ENABLE_UPLOADS = "true";
});

afterEach(async () => {
  const { _resetWritableDbForTests } = await import("@/lib/uploads/writableDb");
  _resetWritableDbForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.OCR_CACHE_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.ASSAY_ENABLE_UPLOADS;
  delete process.env.MAX_UPLOAD_FILE_BYTES;
  delete process.env.MAX_FILES_PER_CONVERSATION;
  delete process.env.STORAGE_CAP_BYTES;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/uploads", () => {
  it("refuses every upload when disabled (production, flag unset)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.ASSAY_ENABLE_UPLOADS;
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
});
