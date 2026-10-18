import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetRateLimitsForTests,
  clearLoginAttempts,
  constantTimeEqual,
  createSessionToken,
  getPasscode,
  isRateLimited,
  recordFailedLogin,
  verifySessionToken,
} from "./auth";

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret";
  process.env.SESSION_TTL_HOURS = "1";
  _resetRateLimitsForTests();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_TTL_HOURS;
  delete process.env.ASSAY_PASSCODE;
});

describe("constantTimeEqual", () => {
  it("matches identical strings", () => {
    expect(constantTimeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("rejects different strings, including differing lengths", () => {
    expect(constantTimeEqual("hunter2", "hunter3")).toBe(false);
    expect(constantTimeEqual("hunter2", "hunter22")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("getPasscode", () => {
  it("is null when unset, so login can never succeed by accident", () => {
    expect(getPasscode()).toBeNull();
  });

  it("returns the configured value", () => {
    process.env.ASSAY_PASSCODE = "let-me-in";
    expect(getPasscode()).toBe("let-me-in");
  });
});

describe("session tokens", () => {
  it("round-trips: a freshly created token verifies", async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a missing or empty token", async () => {
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await verifySessionToken(null)).toBe(false);
    expect(await verifySessionToken("")).toBe(false);
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken();
    const [payload, signature] = token.split(".");
    const tampered = `${payload}x.${signature}`;
    expect(await verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken();
    const [payload, signature] = token.split(".");
    const tampered = `${payload}.${signature.slice(0, -1)}x`;
    expect(await verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken();
    process.env.SESSION_SECRET = "a-different-secret";
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects an expired token", async () => {
    // A vanishingly short TTL, then a real delay past it — exercises the
    // actual expiry check rather than a negative-input edge case (a
    // negative or zero TTL is nonsensical config, not "already expired",
    // and sessionTtlMs() falls back to the default for it on purpose).
    process.env.SESSION_TTL_HOURS = String(1 / (60 * 60 * 1000)); // ~1ms
    const token = await createSessionToken();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects a malformed token", async () => {
    expect(await verifySessionToken("not-a-real-token")).toBe(false);
    expect(await verifySessionToken("a.b.c")).toBe(false);
  });
});

describe("login rate limiting", () => {
  it("allows attempts under the limit, then blocks", () => {
    const key = "1.2.3.4";
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(key)).toBe(false);
      recordFailedLogin(key);
    }
    expect(isRateLimited(key)).toBe(true);
  });

  it("is keyed independently per caller", () => {
    for (let i = 0; i < 5; i++) recordFailedLogin("1.1.1.1");
    expect(isRateLimited("1.1.1.1")).toBe(true);
    expect(isRateLimited("2.2.2.2")).toBe(false);
  });

  it("a successful login clears the counter", () => {
    const key = "9.9.9.9";
    recordFailedLogin(key);
    recordFailedLogin(key);
    clearLoginAttempts(key);
    expect(isRateLimited(key)).toBe(false);
  });
});
