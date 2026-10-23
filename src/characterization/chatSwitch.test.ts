import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, openIndex } from "../../scripts/indexer/store";
import { POST as chat } from "@/app/api/chat/route";
import { GET as config } from "@/app/api/config/route";
import { POST as sessionSearch } from "@/app/api/session-search/route";
import { POST as title } from "@/app/api/title/route";
import { CHAT_DISABLED_MESSAGE, isChatEnabled } from "@/config/features";
import { startLmStudioTripwire, type LmStudioTripwire } from "@/test/lmStudioTripwire";

/**
 * Characterization (pinned at the pre-library tag): the chat switch as a
 * matrix -- for chat off (the default) and chat on, what /api/chat,
 * /api/title, /api/config and /api/session-search each do, and whether
 * anything reaches LM Studio. Library settings are new and default off;
 * with none of them set, every cell here must stay as it is.
 */

let dir: string;
let tripwire: LmStudioTripwire;

function json(body: unknown) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-char-chat-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
  tripwire = await startLmStudioTripwire();
  process.env.LM_STUDIO_BASE_URL = tripwire.baseURL;
  delete process.env.LOCUS_CHAT_ENABLED;
  delete process.env.LM_STUDIO_MODEL;
  delete process.env.LOCUS_RETENTION_DAYS;

  const db = openIndex(process.env.SEARCH_INDEX_PATH);
  insertUploadedDocument(db, {
    conversationId: "c1",
    originalFilename: "a.pdf",
    storedFilename: "a.pdf",
    sha256: "a",
    sizeBytes: 1,
    ocrLang: "eng",
    settings: "v1",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    pages: [
      {
        pageNo: 1,
        pageLabel: null,
        source: "text",
        ocrReason: null,
        imageCoverage: 0,
        layerText: "the ocelot clause",
        ocrText: null,
        error: null,
      },
    ],
  });
  db.close();
});

afterEach(async () => {
  await tripwire.close();
  delete process.env.SEARCH_INDEX_PATH;
  delete process.env.LM_STUDIO_BASE_URL;
  delete process.env.LOCUS_CHAT_ENABLED;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("characterization: chat off (default, no settings)", () => {
  it("is off with nothing set", () => {
    expect(isChatEnabled()).toBe(false);
  });

  it("/api/chat and /api/title refuse with 403 + the disabled message; nothing reaches LM Studio", async () => {
    for (const [route, body] of [
      [chat, { messages: [{ role: "user", content: "hi" }] }],
      [title, { message: "hi" }],
    ] as const) {
      const res = await route(new Request("http://localhost/x", json(body)));
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(CHAT_DISABLED_MESSAGE);
    }
    expect(CHAT_DISABLED_MESSAGE).toBe(
      "Chat is disabled: Locus is running as a document search tool. Set LOCUS_CHAT_ENABLED=true and restart to turn model replies back on."
    );
    expect(tripwire.hits).toEqual([]);
  });

  it("session search answers with no model involved", async () => {
    const res = await sessionSearch(new Request("http://localhost/api/session-search", json({ conversationId: "c1", message: "ocelot" })));
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.result.totalPages).toBe(1);
    expect(tripwire.hits).toEqual([]);
  });

  it("/api/config is exactly { model, retentionDays }", async () => {
    const res = await config();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ model: "qwen/qwen3-4b", retentionDays: null });
  });
});

describe("characterization: chat on (LOCUS_CHAT_ENABLED=true)", () => {
  beforeEach(() => {
    process.env.LOCUS_CHAT_ENABLED = "true";
  });

  it("/api/chat streams the search result first, then calls LM Studio", async () => {
    const res = await chat(
      new Request("http://localhost/api/chat", json({ conversationId: "c1", messages: [{ role: "user", content: "ocelot" }] }))
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const events = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    expect(events[0].type).toBe("searchResult");
    expect(events[0].result.totalPages).toBe(1);
    expect(tripwire.hits.some((h) => h.startsWith("POST /v1/chat/completions"))).toBe(true);
  });

  it("/api/title calls LM Studio (and degrades to an empty title when it fails)", async () => {
    const res = await title(new Request("http://localhost/api/title", json({ message: "hello there" })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: "" });
    expect(tripwire.hits.length).toBeGreaterThan(0);
  });

  it("/api/config is unchanged by the switch", async () => {
    expect(await (await config()).json()).toEqual({ model: "qwen/qwen3-4b", retentionDays: null });
  });
});
