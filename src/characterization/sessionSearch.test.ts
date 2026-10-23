import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, openIndex, type ExtractedPage } from "../../scripts/indexer/store";
import { POST } from "@/app/api/session-search/route";
import type { SessionSearchResponse } from "@/lib/sessionSearchClient";

/**
 * Characterization (pinned at the pre-library tag): /api/session-search's
 * exact responses -- every field of the result, document summary and page
 * hit, ordering, quoted-text extraction, the loose fallback, "show more"
 * paging, and session isolation. The library feature adds a scope beside
 * this; with the library off (the default) nothing here may change.
 */

let dir: string;

function page(pageNo: number, layerText: string): ExtractedPage {
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

function seed(conversationId: string, originalFilename: string, pages: ExtractedPage[]) {
  const db = openIndex(process.env.SEARCH_INDEX_PATH!);
  insertUploadedDocument(db, {
    conversationId,
    originalFilename,
    storedFilename: `${originalFilename}.stored.pdf`,
    sha256: `${conversationId}-${originalFilename}`,
    sizeBytes: 123,
    ocrLang: "eng+hin",
    settings: "v1",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    pages,
  });
  db.close();
}

async function post(body: unknown): Promise<{ status: number; headers: Headers; json: SessionSearchResponse }> {
  const res = await POST(
    new Request("http://localhost/api/session-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, headers: res.headers, json: res.status === 200 ? await res.json() : null };
}

/** tookMs is wall-clock; everything else is deterministic. */
function stable(out: SessionSearchResponse) {
  if (out.status !== "ok") return out;
  const strip = (r: typeof out.result) => ({ ...r, tookMs: "<ms>" });
  return {
    ...out,
    result: strip(out.result),
    looseAlternative: out.looseAlternative && strip(out.looseAlternative),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-session-search-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
});

afterEach(() => {
  delete process.env.SEARCH_INDEX_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("characterization: /api/session-search", () => {
  it("answers no-files (no index at all), uncached", async () => {
    const out = await post({ conversationId: "c1", message: "anything" });
    expect(out.status).toBe(200);
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(out.json).toEqual({ status: "no-files" });
  });

  it("returns this exact result: documents in filename order, hits by document then page", async () => {
    seed("c1", "b-second.pdf", [page(1, "Earnest Money here"), page(2, "nothing"), page(3, "earnest money again")]);
    seed("c1", "a-first.pdf", [page(1, "no match"), page(2, "the EARNEST MONEY deposit")]);
    seed("c2", "other-session.pdf", [page(1, "earnest money elsewhere")]);

    const out = await post({ conversationId: "c1", message: "earnest money" });
    expect(stable(out.json)).toMatchSnapshot();
  });

  it("searches only the first quoted phrase when there is one", async () => {
    seed("c1", "a.pdf", [page(1, "the deposit clause applies"), page(2, "is there anything")]);
    const out = await post({ conversationId: "c1", message: 'is there "deposit clause" anywhere? "applies"' });
    if (out.json.status !== "ok") throw new Error("expected ok");
    expect(out.json.result.query).toBe("deposit clause");
    expect(out.json.result.hits.map((h) => h.pageNo)).toEqual([1]);
  });

  it("offers the loose alternative only when exact finds nothing and loose does", async () => {
    seed("c1", "a.pdf", [page(1, "ref 26/2080 dated")]);
    const out = await post({ conversationId: "c1", message: "26-2080" });
    expect(stable(out.json)).toMatchSnapshot();
  });

  it("pages in windows of 50: first window, then offset 50 continues exactly", async () => {
    seed("c1", "big.pdf", Array.from({ length: 120 }, (_, i) => page(i + 1, "an ocelot clause")));
    const first = await post({ conversationId: "c1", message: "ocelot" });
    if (first.json.status !== "ok") throw new Error("expected ok");
    expect([first.json.result.offset, first.json.result.limit, first.json.result.hits.length]).toEqual([0, 50, 50]);
    expect(first.json.result.hasMore).toBe(true);

    const pages: number[] = first.json.result.hits.map((h) => h.pageNo);
    for (const offset of [50, 100]) {
      const next = await post({ conversationId: "c1", message: "ocelot", mode: "exact", offset });
      if (next.json.status !== "ok") throw new Error("expected ok");
      expect(next.json.looseAlternative).toBeNull();
      pages.push(...next.json.result.hits.map((h) => h.pageNo));
    }
    expect(pages).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
  });

  it("answers a session with files but zero matches as ok with an empty result", async () => {
    seed("c1", "a.pdf", [page(1, "plain words")]);
    const out = await post({ conversationId: "c1", message: "zzzz-not-present" });
    expect(stable(out.json)).toMatchSnapshot();
  });

  it("rejects bad input with these exact 400 messages", async () => {
    const cases: Array<[unknown, string]> = [
      [{ conversationId: "", message: "x" }, "`conversationId` must be a non-empty string"],
      [{ conversationId: "c", message: "  " }, "`message` must contain some text"],
      [{ conversationId: "c", message: "x".repeat(20_001) }, "`message` is limited to 20000 characters"],
      [{ conversationId: "c", message: "x", offset: -1, mode: "exact" }, "`offset` must be a non-negative integer"],
      [{ conversationId: "c", message: "x", offset: 0, mode: "nope" }, '`mode` must be "exact" or "loose"'],
    ];
    for (const [body, message] of cases) {
      const res = await POST(
        new Request("http://localhost/api/session-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      expect([res.status, await res.text()]).toEqual([400, message]);
    }
  });
});
