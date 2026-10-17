import { describe, expect, it } from "vitest";
import { MAX_QUERY_CHARS, validateSearchRequest } from "./searchRequest";

describe("validateSearchRequest", () => {
  it("accepts a query and fills in defaults", () => {
    expect(validateSearchRequest({ query: "earnest money" })).toEqual({
      ok: true,
      request: { query: "earnest money", mode: "exact", offset: 0, limit: 50 },
    });
  });

  it("accepts loose mode and pagination", () => {
    expect(validateSearchRequest({ query: "x", mode: "loose", offset: 100, limit: 200 })).toMatchObject({
      ok: true,
      request: { mode: "loose", offset: 100, limit: 200 },
    });
  });

  it.each([
    [null, "JSON object"],
    [[], "JSON object"],
    ["earnest", "JSON object"],
    [{}, "`query` must be a string"],
    [{ query: 42 }, "`query` must be a string"],
    [{ query: ["a"] }, "`query` must be a string"],
    [{ query: { $ne: "" } }, "`query` must be a string"],
    [{ query: "" }, "must contain some text"],
    [{ query: " \n\t " }, "must contain some text"],
    [{ query: "x".repeat(MAX_QUERY_CHARS + 1) }, `limited to ${MAX_QUERY_CHARS}`],
    [{ query: "x", mode: "regex" }, "`mode`"],
    [{ query: "x", offset: -1 }, "`offset`"],
    [{ query: "x", offset: 1.5 }, "`offset`"],
    [{ query: "x", offset: "0" }, "`offset`"],
    [{ query: "x", limit: 0 }, "`limit`"],
    [{ query: "x", limit: 201 }, "`limit`"],
    [{ query: "x", limit: Number.NaN }, "`limit`"],
  ])("rejects %j", (body, expectedError) => {
    const result = validateSearchRequest(body);
    if (result.ok) throw new Error("Expected validation failure");
    expect(result.error).toContain(expectedError);
  });

  it("accepts a query of exactly the maximum length", () => {
    expect(validateSearchRequest({ query: "x".repeat(MAX_QUERY_CHARS) })).toMatchObject({ ok: true });
  });
});
