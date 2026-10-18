import { describe, expect, it } from "vitest";
import { cleanTitle, createEmptyConversation, deriveTitle } from "./conversations";
import type { DisplayMessage } from "./types";

function userMessage(content: string): DisplayMessage {
  return {
    id: "m1",
    role: "user",
    content,
    reasoning: "",
    reasoningMs: null,
    isStreaming: false,
  };
}

describe("cleanTitle", () => {
  it("collapses whitespace", () => {
    expect(cleanTitle("  does   it   mention\n\nearnest money?  ")).toBe(
      "does it mention earnest money"
    );
  });

  it("strips wrapping quotes the model sometimes adds", () => {
    expect(cleanTitle('"Earnest money clause"')).toBe("Earnest money clause");
    expect(cleanTitle("'Earnest money clause'")).toBe("Earnest money clause");
  });

  it("strips trailing sentence punctuation", () => {
    expect(cleanTitle("Earnest money clause.")).toBe("Earnest money clause");
    expect(cleanTitle("What is the deadline?")).toBe("What is the deadline");
  });

  it("truncates with an ellipsis past 40 characters", () => {
    const long = "a".repeat(60);
    const result = cleanTitle(long);
    expect(result.length).toBe(41); // 40 chars + the ellipsis
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("deriveTitle", () => {
  it("is empty with no user message", () => {
    expect(deriveTitle([])).toBe("");
  });

  it("uses the first user message, cleaned", () => {
    expect(deriveTitle([userMessage("  does it mention earnest money?  ")])).toBe(
      "does it mention earnest money"
    );
  });

  it("ignores a leading assistant message (shouldn't happen, but isn't trusted to)", () => {
    const assistant: DisplayMessage = {
      id: "a1",
      role: "assistant",
      content: "hello",
      reasoning: "",
      reasoningMs: null,
      isStreaming: false,
      failure: null,
    };
    expect(deriveTitle([assistant, userMessage("real question")])).toBe("real question");
  });
});

describe("createEmptyConversation", () => {
  it("starts with no title and no titleSource", () => {
    const c = createEmptyConversation();
    expect(c.title).toBe("");
    expect(c.titleSource).toBeUndefined();
  });
});
