import { describe, expect, it } from "vitest";
import { toHistoryPayload } from "./history";
import type { DisplayMessage } from "./types";

const message = (over: Partial<DisplayMessage>): DisplayMessage => ({
  id: "1",
  role: "assistant",
  content: "",
  reasoning: "",
  reasoningMs: null,
  isStreaming: false,
  ...over,
});

describe("toHistoryPayload", () => {
  it("sends only role and content", () => {
    expect(
      toHistoryPayload([
        message({ role: "user", content: "hi", reasoning: "secret", reasoningMs: 42 }),
      ])
    ).toEqual([{ role: "user", content: "hi" }]);
  });

  it("never replays a transport failure as something the assistant said", () => {
    // The regression this guards: an ECONNREFUSED rendered in the assistant
    // slot must not come back as assistant history on the next turn.
    const payload = toHistoryPayload([
      message({ role: "user", content: "hello" }),
      message({ content: "", failure: "Could not reach LM Studio — ECONNREFUSED" }),
      message({ role: "user", content: "try again" }),
    ]);

    expect(payload).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "try again" },
    ]);
    expect(JSON.stringify(payload)).not.toContain("ECONNREFUSED");
  });

  it("keeps partial output from a turn that failed midway", () => {
    const payload = toHistoryPayload([
      message({ content: "Here is half an ans", failure: "Stream ended unexpectedly." }),
    ]);

    expect(payload).toEqual([{ role: "assistant", content: "Here is half an ans" }]);
    expect(JSON.stringify(payload)).not.toContain("Stream ended");
  });

  it("drops a cancelled turn that produced nothing", () => {
    expect(toHistoryPayload([message({ content: "" })])).toEqual([]);
  });
});
