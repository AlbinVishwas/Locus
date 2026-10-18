import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetRateLimitsForTests } from "@/lib/auth";
import { POST } from "./route";

function post(body: unknown, ip = "1.2.3.4") {
  return POST(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  process.env.ASSAY_PASSCODE = "correct-passcode";
  process.env.SESSION_SECRET = "test-secret";
  _resetRateLimitsForTests();
});

afterEach(() => {
  delete process.env.ASSAY_PASSCODE;
  delete process.env.SESSION_SECRET;
});

describe("POST /api/login", () => {
  it("rejects the wrong passcode", async () => {
    const res = await post({ passcode: "nope" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("accepts the right passcode and sets a session cookie", async () => {
    const res = await post({ passcode: "correct-passcode" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("assay_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("fails closed when no passcode is configured", async () => {
    delete process.env.ASSAY_PASSCODE;
    const res = await post({ passcode: "anything" });
    expect(res.status).toBe(401);
  });

  it("rejects malformed bodies", async () => {
    const res = await post({ passcode: 12345 });
    expect(res.status).toBe(400);
  });

  it("rate-limits repeated failures from the same caller", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post({ passcode: "wrong" }, "5.5.5.5");
      expect(res.status).toBe(401);
    }
    const blocked = await post({ passcode: "correct-passcode" }, "5.5.5.5");
    expect(blocked.status).toBe(429);
  });

  it("does not rate-limit a different caller", async () => {
    for (let i = 0; i < 5; i++) await post({ passcode: "wrong" }, "6.6.6.6");
    const res = await post({ passcode: "correct-passcode" }, "7.7.7.7");
    expect(res.status).toBe(200);
  });
});
