import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";
import { proxy } from "./proxy";

function request(path: string, cookie?: string) {
  const req = new NextRequest(new URL(path, "http://localhost"));
  if (cookie) req.cookies.set(SESSION_COOKIE, cookie);
  return req;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret";
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
});

describe("proxy", () => {
  it("lets /login and /api/login through without a session", async () => {
    expect((await proxy(request("/login"))).status).toBe(200);
    expect((await proxy(request("/api/login"))).status).toBe(200);
    expect((await proxy(request("/api/logout"))).status).toBe(200);
  });

  it("redirects an unauthenticated page request to /login", async () => {
    const res = await proxy(request("/"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?next=%2F");
  });

  it("401s an unauthenticated API request instead of redirecting", async () => {
    const res = await proxy(request("/api/chat"));
    expect(res.status).toBe(401);
  });

  it("passes through a request with a valid session", async () => {
    const token = await createSessionToken();
    const res = await proxy(request("/", token));
    expect(res.status).toBe(200);
  });

  it("treats a tampered session cookie as unauthenticated", async () => {
    const token = await createSessionToken();
    const res = await proxy(request("/", token + "x"));
    expect(res.status).toBe(307);
  });

  it("treats a session signed with a different secret as unauthenticated", async () => {
    const token = await createSessionToken();
    process.env.SESSION_SECRET = "a-different-secret";
    const res = await proxy(request("/", token));
    expect(res.status).toBe(307);
  });
});
