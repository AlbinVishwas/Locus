import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixturePdf } from "../../scripts/indexer/fixtures";
import { DELETE, GET, POST } from "@/app/api/uploads/route";
import { POST as sessionSearch } from "@/app/api/session-search/route";
import type { SessionSearchResponse } from "@/lib/sessionSearchClient";

/**
 * Characterization (pinned at the pre-library tag): one real PDF through
 * the upload flow exactly as the browser drives it -- POST (SSE progress),
 * GET (the file list), a session search, DELETE -- and exactly where on
 * disk it all lands. The library feature wraps uploads without changing
 * them; this is what "unchanged" means, including the storage behaviour
 * (files under UPLOADS_DIR, index and OCR cache next to SEARCH_INDEX_PATH,
 * scratch files in the OS temp dir and gone afterwards).
 *
 * Needs poppler + tesseract, like the other real-upload tests
 * (SKIP_OCR_TESTS=1 skips it).
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";

let dir: string;

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

function uploadTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("assay-upload-"));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-upload-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  process.env.UPLOADS_DIR = path.join(dir, "uploads");
  process.env.LOCUS_ENABLE_UPLOADS = "true";
  delete process.env.OCR_CACHE_PATH;
});

afterEach(async () => {
  const { _resetWritableDbForTests } = await import("@/lib/uploads/writableDb");
  _resetWritableDbForTests();
  const { _resetSharedContextForTests } = await import("@/lib/uploads/pipeline");
  _resetSharedContextForTests();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.UPLOADS_DIR;
  delete process.env.LOCUS_ENABLE_UPLOADS;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("characterization: upload flow", () => {
  it.skipIf(skipOcr)(
    "POST streams these stages, then the file is listed, searchable, stored content-addressed, and deletable",
    async () => {
      for (const tool of ["pdfinfo", "pdftotext", "pdftoppm", "pdfimages", "tesseract"]) {
        execFileSync("which", [tool], { stdio: "ignore" });
      }
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-fixture-"));
      const pdf = path.join(fixtureDir, "notice.pdf");
      await writeFixturePdf(pdf, [{ lines: ["the ocelot earnest money clause"] }, { lines: ["page two text"] }], {
        workDir: fixtureDir,
      });
      const bytes = fs.readFileSync(pdf);
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      const tempBefore = new Set(uploadTempDirs());

      // --- POST: the SSE stage sequence ---
      const form = new FormData();
      form.set("conversationId", "conv-1");
      form.set("file", new File([bytes], "Notice (final).pdf", { type: "application/pdf" }));
      const res = await POST(new Request("http://localhost/api/uploads", { method: "POST", body: form }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      const events = (await res.text())
        .split("\n\n")
        .filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
      // Both pages need OCR (see the search below for why), which runs
      // after the document is written: one running-ocr event per page done.
      expect(events).toEqual([
        { type: "stage", stage: "uploading" },
        { type: "stage", stage: "reading" },
        { type: "stage", stage: "indexing" },
        { type: "stage", stage: "running-ocr", page: 1, totalPages: 2 },
        { type: "stage", stage: "running-ocr", page: 2, totalPages: 2 },
        { type: "ready", docId: 1, pageCount: 2 },
      ]);

      // --- GET: the file list ---
      const list = await GET(new Request("http://localhost/api/uploads?conversationId=conv-1"));
      expect(list.headers.get("cache-control")).toBe("no-store");
      const { documents } = (await list.json()) as { documents: Array<Record<string, unknown>> };
      expect(documents).toHaveLength(1);
      const sha256 = documents[0].sha256 as string;
      expect(documents[0]).toEqual({
        id: 1,
        conversationId: "conv-1",
        originalFilename: "Notice (final).pdf",
        filename: `${sha256}.pdf`,
        sha256,
        sizeBytes: bytes.length,
        pageCount: 2,
        status: "ready",
        uploadedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
        expiresAt: null,
        error: null,
      });

      // --- Session search over it ---
      const searchRes = await sessionSearch(
        new Request("http://localhost/api/session-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: "conv-1", message: "earnest money" }),
        })
      );
      const out = (await searchRes.json()) as SessionSearchResponse;
      if (out.status !== "ok") throw new Error("expected ok");
      expect(out.result.totalPages).toBe(1);
      // Each fixture page's text layer is under MIN_TEXT_CHARS (30), so it
      // counts as missing and the page is OCR'd ("ocr") -- but the layer is
      // still stored and still matches, so the hit isn't OCR-only.
      expect(out.result.hits.map((h) => [h.filename, h.pageNo, h.source, h.ocrOnly])).toEqual([
        ["Notice (final).pdf", 1, "ocr", false],
      ]);

      // --- Exactly where everything landed ---
      // (-wal/-shm are SQLite's own WAL side files, present while the
      // writable connection is open.)
      expect(listTree(dir)).toEqual([
        "index/ocr-cache.db",
        "index/search.db",
        "index/search.db-shm",
        "index/search.db-wal",
        `uploads/${sha256}.pdf`,
      ]);
      expect(fs.readFileSync(path.join(dir, "uploads", `${sha256}.pdf`)).equals(bytes)).toBe(true);
      // The scratch dir in the OS temp folder is created per upload and removed after.
      expect(uploadTempDirs().filter((n) => !tempBefore.has(n))).toEqual([]);

      // --- DELETE one file ---
      const del = await DELETE(new Request("http://localhost/api/uploads?conversationId=conv-1&docId=1", { method: "DELETE" }));
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });
      expect(fs.existsSync(path.join(dir, "uploads", `${sha256}.pdf`))).toBe(false);
      const after = await GET(new Request("http://localhost/api/uploads?conversationId=conv-1"));
      expect(await after.json()).toEqual({ documents: [] });
    },
    60_000
  );

  it("refuses with 403 and this message when uploads are disabled (production, flag unset)", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prevNodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    delete process.env.LOCUS_ENABLE_UPLOADS;
    try {
      const res = await POST(new Request("http://localhost/api/uploads", { method: "POST", body: new FormData() }));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(
        "Uploads are disabled. Set LOCUS_ENABLE_UPLOADS=true only for a trusted local deployment."
      );
      // GET degrades to an empty list rather than an error.
      const list = await GET(new Request("http://localhost/api/uploads?conversationId=c"));
      expect(await list.json()).toEqual({ documents: [] });
    } finally {
      env.NODE_ENV = prevNodeEnv;
    }
  });
});
