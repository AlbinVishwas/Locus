import { describe, expect, it } from "vitest";
import { validateChatRequest } from "./chatRequest";

describe("validateChatRequest", () => {
  it("accepts text-only messages with supported roles", () => {
    expect(
      validateChatRequest({
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      })
    ).toMatchObject({ ok: true });
  });

  it.each([
    [undefined, "`messages` array is required"],
    [{ messages: [{ role: "tool", content: "x" }] }, "supported role"],
    [{ messages: [{ role: "user", content: ["x"] }] }, "string content"],
  ])("rejects malformed payloads", (body, expectedError) => {
    const result = validateChatRequest(body);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain(expectedError);
  });

  it("rejects too many messages", () => {
    const result = validateChatRequest({
      messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain("At most 40 messages");
  });

  it("rejects a total payload above the combined limit", () => {
    // Each message is individually legal; only the running total is not.
    const result = validateChatRequest({
      messages: Array.from({ length: 6 }, () => ({
        role: "user",
        content: "x".repeat(19_000),
      })),
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain("Total message content is limited");
  });

  it.each([
    [{ messages: "hi" }, "`messages` array is required"],
    [{ messages: [] }, "`messages` array is required"],
    [{ messages: ["hello"] }, "must be an object"],
    [{ messages: [null] }, "must be an object"],
    [{ messages: [{ role: "user", content: null }] }, "string content"],
  ])("rejects malformed shapes", (body, expectedError) => {
    const result = validateChatRequest(body);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain(expectedError);
  });

  it("accepts a payload exactly at the message-count limit", () => {
    expect(
      validateChatRequest({
        messages: Array.from({ length: 40 }, () => ({ role: "user", content: "x" })),
      })
    ).toMatchObject({ ok: true });
  });

  it("strips unexpected fields rather than forwarding them to LM Studio", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "hi", tool_calls: [{ id: "x" }] }],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected validation to pass");
    expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("rejects a message above the per-message limit", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "x".repeat(20_001) }],
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain("Each message is limited");
  });
});
