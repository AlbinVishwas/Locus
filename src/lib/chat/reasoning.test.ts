import { afterEach, describe, expect, it } from "vitest";
import { shouldSuppressReasoning, withReasoningSuppressed } from "./reasoning";

afterEach(() => {
  delete process.env.LOCUS_DISABLE_REASONING;
});

describe("shouldSuppressReasoning", () => {
  it("is on by default for a Qwen3 model, case-insensitively", () => {
    expect(shouldSuppressReasoning("qwen/qwen3-4b")).toBe(true);
    expect(shouldSuppressReasoning("QWEN3-30B-A3B")).toBe(true);
  });

  it("is off by default for any other model", () => {
    expect(shouldSuppressReasoning("llama-3.1-8b")).toBe(false);
  });

  it("LOCUS_DISABLE_REASONING=true forces it on for a non-Qwen3 model", () => {
    process.env.LOCUS_DISABLE_REASONING = "true";
    expect(shouldSuppressReasoning("llama-3.1-8b")).toBe(true);
  });

  it("LOCUS_DISABLE_REASONING=false forces it off for a Qwen3 model", () => {
    process.env.LOCUS_DISABLE_REASONING = "false";
    expect(shouldSuppressReasoning("qwen/qwen3-4b")).toBe(false);
  });
});

describe("withReasoningSuppressed", () => {
  it("appends /no_think to the latest user message only", () => {
    const messages = [
      { role: "system" as const, content: "be helpful" },
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "second question" },
    ];
    const result = withReasoningSuppressed(messages);
    expect(result[3].content).toBe("second question /no_think");
    expect(result[1].content).toBe("first question"); // untouched
  });

  it("never mutates the array it was given", () => {
    const messages = [{ role: "user" as const, content: "hello" }];
    withReasoningSuppressed(messages);
    expect(messages[0].content).toBe("hello");
  });

  it("is a no-op when there's no string-content user message", () => {
    const messages = [{ role: "assistant" as const, content: "just an answer" }];
    expect(withReasoningSuppressed(messages)).toBe(messages);
  });
});
