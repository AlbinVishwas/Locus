import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument } from "../../../../scripts/indexer/store";
import type { StreamEvent } from "@/lib/types";
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
});

afterEach(() => {
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.LM_STUDIO_BASE_URL;
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
