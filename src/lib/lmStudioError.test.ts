import { describe, expect, it } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError } from "openai";
import { describeLmStudioError, rootCause } from "./lmStudioError";

const BASE = "http://localhost:1234/v1";

/** Mirrors how undici nests the real reason under the SDK's generic wrapper. */
function undiciStyle(code: string, message: string): APIConnectionError {
  const inner = Object.assign(new Error(message), { code });
  const wrapper = new TypeError("fetch failed", { cause: inner });
  return new APIConnectionError({ cause: wrapper });
}

describe("rootCause", () => {
  it("unwraps past undici's contentless 'fetch failed' wrapper", () => {
    expect(rootCause(undiciStyle("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1234")))
      .toBe("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:1234");
  });

  it("falls back to a cause that has no error code", () => {
    const err = new APIConnectionError({
      cause: new TypeError("fetch failed", { cause: new Error("bad port") }),
    });
    expect(rootCause(err)).toBe("bad port");
  });

  it("returns null when there is no nested cause to report", () => {
    expect(rootCause(new Error("plain"))).toBeNull();
  });

  it("terminates on a self-referential cause chain", () => {
    const a = new Error("a");
    Object.defineProperty(a, "cause", { get: () => a });
    expect(() => rootCause(a)).not.toThrow();
  });
});

describe("describeLmStudioError", () => {
  it("names the transport failure instead of the SDK's generic string", () => {
    const message = describeLmStudioError(
      undiciStyle("ENOTFOUND", "getaddrinfo ENOTFOUND tunnel.example"),
      "https://tunnel.example/v1",
      120_000
    );
    expect(message).toContain("Could not reach LM Studio at https://tunnel.example/v1");
    expect(message).toContain("ENOTFOUND");
    expect(message).not.toBe("Connection error.");
  });

  it("reports a timeout distinctly from a connection failure", () => {
    // APIConnectionTimeoutError extends APIConnectionError, so ordering of the
    // instanceof checks is what this guards.
    const message = describeLmStudioError(
      new APIConnectionTimeoutError({}),
      BASE,
      120_000
    );
    expect(message).toBe(`LM Studio at ${BASE} did not respond within 120s.`);
  });

  it("passes through an ordinary API error message untouched", () => {
    expect(describeLmStudioError(new Error("model not found"), BASE, 120_000)).toBe(
      "model not found"
    );
  });

  it("handles a non-Error throw", () => {
    expect(describeLmStudioError("boom", BASE, 120_000)).toBe(
      "Unknown error contacting LM Studio"
    );
  });
});
