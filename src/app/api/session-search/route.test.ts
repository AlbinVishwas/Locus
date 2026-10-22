import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, openIndex } from "../../../../scripts/indexer/store";
import type { SessionSearchResponse } from "@/lib/sessionSearchClient";
import { startLmStudioTripwire, type LmStudioTripwire } from "@/test/lmStudioTripwire";
import { POST } from "./route";

/**
 * The search-only turn (chat off): every message is a search over that
 * session's own files, and nothing about it ever reaches LM Studio. Every
 * case runs with LM_STUDIO_BASE_URL pointed at a tripwire that records
 * any request it gets -- and checks it got none.
 */

let dir: string;
let tripwire: LmStudioTripwire;

function page(layerText: string) {
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

function seed(conversationId: string, text: string) {
  const db = openIndex(process.env.SEARCH_INDEX_PATH!);
  insertUploadedDocument(db, {
    conversationId,
    originalFilename: `${conversationId}.pdf`,
    storedFilename: `${conversationId}.pdf`,
    sha256: conversationId,
    sizeBytes: 1,
    ocrLang: "eng",
    settings: "v1",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    pages: [page(text)],
  });
  db.close();
}

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/session-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

async function search(conversationId: string, message: string): Promise<SessionSearchResponse> {
  const res = await post({ conversationId, message });
  expect(res.status).toBe(200);
  return (await res.json()) as SessionSearchResponse;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-session-search-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  tripwire = await startLmStudioTripwire();
  process.env.LM_STUDIO_BASE_URL = tripwire.baseURL;
});

afterEach(async () => {
  // The point of the whole route: no case, of any outcome, touched LM Studio.
  expect(tripwire.hits).toEqual([]);
  await tripwire.close();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.LM_STUDIO_BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/session-search", () => {
  it("answers no-files when nothing has ever been uploaded (no index at all)", async () => {
    expect(await search("conv-a", "anything")).toEqual({ status: "no-files" });
  });

  it("answers no-files for a session whose files belong to another session", async () => {
    seed("conv-other", "the ocelot deposit clause");
    expect(await search("conv-a", "ocelot")).toEqual({ status: "no-files" });
  });

  it("searches the whole message as exact text and finds it", async () => {
    seed("conv-a", "the ocelot deposit clause applies");
    const out = await search("conv-a", "ocelot deposit");
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.result.mode).toBe("exact");
    expect(out.result.totalPages).toBe(1);
    expect(out.looseAlternative).toBeNull();
  });

  it("searches only the quoted text when the message has a quote", async () => {
    seed("conv-a", "the ocelot deposit clause applies");
    const out = await search("conv-a", 'is there "deposit clause" anywhere?');
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.result.query).toBe("deposit clause");
    expect(out.result.totalPages).toBe(1);
  });

  it("returns zero matches as a result (not an error), with the loose hint when loose finds something", async () => {
    seed("conv-a", "Reference 26/2080 appears here");
    const out = await search("conv-a", "26-2080");
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.result.totalPages).toBe(0);
    expect(out.looseAlternative?.totalPages).toBeGreaterThan(0);
  });

  it("returns zero matches with no loose hint when loose finds nothing either", async () => {
    seed("conv-a", "the ocelot deposit clause");
    const out = await search("conv-a", "pangolin");
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.result.totalPages).toBe(0);
    expect(out.looseAlternative).toBeNull();
  });

  it("works with LM Studio not running at all (nothing listening)", async () => {
    process.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:1/v1";
    seed("conv-a", "the ocelot deposit clause");
    const out = await search("conv-a", "ocelot");
    expect(out.status).toBe("ok");
  });

  it("rejects bad input with a 400", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ conversationId: "", message: "x" })).status).toBe(400);
    expect((await post({ conversationId: "c", message: "   " })).status).toBe(400);
    expect((await post({ conversationId: "c", message: "x".repeat(20_001) })).status).toBe(400);
  });
});
