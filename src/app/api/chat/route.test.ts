import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument } from "../../../../scripts/indexer/store";
import { CHAT_DISABLED_MESSAGE } from "@/config/features";
import type { StreamEvent } from "@/lib/types";
import { startLmStudioTripwire } from "@/test/lmStudioTripwire";
import { POST } from "./route";

/**
 * The document-search wiring, specifically: it runs before the model is
 * called, it's skipped entirely for a conversation with no uploads, and a
 * search result never reaches the client without a real search having
 * run. LM Studio itself isn't reachable in this environment, so every
 * case here ends in a transport error after whatever document-search
 * event (or lack of one) was already sent -- that's the thing under test,
 * not whether the model answered.
 */

let dir: string;

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-chat-route-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  // Guarantees the LM Studio call fails fast and locally rather than
  // hanging or hitting a real network address.
  process.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:1/v1";
  // These cases are about chat itself; chat-off is its own describe below.
  process.env.LOCUS_CHAT_ENABLED = "true";
});

afterEach(() => {
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.LM_STUDIO_BASE_URL;
  delete process.env.LOCUS_CHAT_ENABLED;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collectEvents(body: unknown): Promise<StreamEvent[]> {
  const res = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const events: StreamEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const line = buffer.slice(0, sep).replace(/^data: /, "");
      buffer = buffer.slice(sep + 2);
      events.push(JSON.parse(line));
    }
  }
  return events;
}

function seedConversationWithFile(conversationId: string, text: string) {
  return import("../../../../scripts/indexer/store").then(({ openIndex }) => {
    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId,
      originalFilename: "Notice.pdf",
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
  });
}

describe("POST /api/chat with chat turned off", () => {
  it("is the default: refuses with a clear message and never reaches LM Studio", async () => {
    delete process.env.LOCUS_CHAT_ENABLED;
    const tripwire = await startLmStudioTripwire();
    process.env.LM_STUDIO_BASE_URL = tripwire.baseURL;
    try {
      await seedConversationWithFile("conv-off", "the ocelot deposit clause");
      const res = await POST(
        new Request("http://localhost/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // A link and a search term, so URL reading and document search
            // would both have had something to do.
            messages: [{ role: "user", content: "ocelot https://example.com/page" }],
            conversationId: "conv-off",
          }),
        })
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(CHAT_DISABLED_MESSAGE);
      expect(tripwire.hits).toEqual([]);
    } finally {
      await tripwire.close();
    }
  });

  it("refuses even a malformed body the same way, before reading it", async () => {
    process.env.LOCUS_CHAT_ENABLED = "false";
    const res = await POST(
      new Request("http://localhost/api/chat", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/chat with chat turned on", () => {
  it("does call LM Studio (the tripwire sees the request)", async () => {
    const tripwire = await startLmStudioTripwire();
    process.env.LM_STUDIO_BASE_URL = tripwire.baseURL;
    try {
      const events = await collectEvents({ messages: [{ role: "user", content: "hello" }] });
      expect(tripwire.hits.some((h) => h.includes("/chat/completions"))).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(true);
    } finally {
      await tripwire.close();
    }
  });
});

describe("POST /api/chat: document search", () => {
  it("never emits a searchResult event when no conversationId is sent", async () => {
    const events = await collectEvents({ messages: [{ role: "user", content: "hello" }] });
    expect(events.some((e) => e.type === "searchResult")).toBe(false);
  });

  it("never emits a searchResult event for a conversation with no uploads", async () => {
    const events = await collectEvents({
      messages: [{ role: "user", content: "hello" }],
      conversationId: "conv-no-files",
    });
    expect(events.some((e) => e.type === "searchResult")).toBe(false);
  });

  it("emits a searchResult event, before any error, for a conversation with uploads", async () => {
    const { openIndex } = await import("../../../../scripts/indexer/store");
    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId: "conv-with-files",
      originalFilename: "Notice.pdf",
      storedFilename: "a.pdf",
      sha256: "a",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [page("the ocelot deposit clause")],
    });
    db.close();

    const events = await collectEvents({
      messages: [{ role: "user", content: "ocelot" }],
      conversationId: "conv-with-files",
    });

    const searchIndex = events.findIndex((e) => e.type === "searchResult");
    expect(searchIndex).toBeGreaterThanOrEqual(0);
    const search = events[searchIndex] as Extract<StreamEvent, { type: "searchResult" }>;
    expect(search.result.hits).toHaveLength(1);

    // Whatever else happened (an LM Studio transport error, in this
    // environment), the search result was sent first.
    const errorIndex = events.findIndex((e) => e.type === "error");
    if (errorIndex !== -1) expect(searchIndex).toBeLessThan(errorIndex);
  });

  it("rejects a malformed conversationId before touching the index", async () => {
    const res = await POST(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], conversationId: 5 }),
      })
    );
    expect(res.status).toBe(400);
  });
});
