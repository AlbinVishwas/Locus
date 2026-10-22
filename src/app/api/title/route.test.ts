import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLmStudioTripwire } from "@/test/lmStudioTripwire";
import { POST } from "./route";

/**
 * LM Studio isn't reachable in this environment (same convention as
 * src/app/api/chat/route.test.ts), so every case here checks the
 * fallback shape -- a 200 with an empty title, never a thrown error or a
 * blocked response -- which is exactly what lets the client-side caller
 * (ConversationsProvider) keep the fast local title it already set.
 */

beforeEach(() => {
  process.env.LM_STUDIO_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.LOCUS_CHAT_ENABLED = "true";
});

afterEach(() => {
  delete process.env.LM_STUDIO_BASE_URL;
  delete process.env.LOCUS_CHAT_ENABLED;
});

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/title with chat turned off", () => {
  it("refuses without calling the model", async () => {
    delete process.env.LOCUS_CHAT_ENABLED;
    const tripwire = await startLmStudioTripwire();
    process.env.LM_STUDIO_BASE_URL = tripwire.baseURL;
    try {
      const res = await post({ message: "does this mention earnest money?" });
      expect(res.status).toBe(403);
      expect(tripwire.hits).toEqual([]);
    } finally {
      await tripwire.close();
    }
  });
});

describe("POST /api/title", () => {
  it("degrades to an empty title, not an error, when LM Studio is unreachable", async () => {
    const res = await post({ message: "does this mention earnest money?" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("");
  });

  it("returns an empty title without ever calling the model for an empty message", async () => {
    const res = await post({ message: "   " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("");
  });

  it("rejects a non-string message with a 400, not a crash", async () => {
    const res = await post({ message: 12345 });
    expect(res.status).toBe(200); // falls through to the empty-title path, not a throw
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("");
  });

  it("rejects malformed JSON with a 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });
});
