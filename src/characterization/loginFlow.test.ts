import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { POST as logout } from "@/app/api/logout/route";
import { SESSION_COOKIE, _resetRateLimitsForTests } from "@/lib/auth";
import { proxy } from "@/proxy";

/**
 * Characterization (pinned at the pre-library tag): the whole login
 * round trip as a browser sees it -- the cookie /api/login sets, the proxy
 * letting that cookie through to pages and APIs, /api/logout clearing it,
 * and what an unauthenticated request gets instead. Any new library route
 * sits behind the same proxy; nothing about this may change.
 */

beforeEach(() => {
  process.env.LOCUS_PASSCODE = "the-passcode";
  process.env.SESSION_SECRET = "characterization-secret";
  delete process.env.SESSION_TTL_HOURS;
  _resetRateLimitsForTests();
});

afterEach(() => {
  delete process.env.LOCUS_PASSCODE;
  delete process.env.SESSION_SECRET;
});

function postLogin(passcode: unknown) {
  return login(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify({ passcode }),
    })
  );
}

function request(pathname: string, cookie?: string) {
  const req = new NextRequest(new URL(pathname, "http://localhost"));
  if (cookie !== undefined) req.cookies.set(SESSION_COOKIE, cookie);
  return req;
}

describe("characterization: login round trip", () => {
  it("login sets this cookie; the proxy lets it through; logout clears it", async () => {
    const res = await postLogin("the-passcode");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const setCookie = res.headers.get("set-cookie")!;
    const [nameValue, ...attributes] = setCookie.split("; ");
    const [name, token] = nameValue.split("=");
    expect(name).toBe("locus_session");
    expect(attributes).toEqual(["Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${168 * 3600}`]);

    // Pages and APIs both pass with the cookie.
    for (const p of ["/", "/search", "/api/session-search", "/api/uploads", "/api/config"]) {
      expect((await proxy(request(p, token))).status, p).toBe(200);
    }

    const out = await logout();
    expect(await out.json()).toEqual({ ok: true });
    expect(out.headers.get("set-cookie")).toBe("locus_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  });

  it("without a session: pages redirect to /login?next=..., APIs get a JSON 401", async () => {
    const page = await proxy(request("/search?q=x"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost/login?next=%2Fsearch%3Fq%3Dx");

    const api = await proxy(request("/api/session-search"));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: "Not authenticated" });

    // An empty cookie is no session either.
    expect((await proxy(request("/api/uploads", ""))).status).toBe(401);
  });

  it("only /login, /api/login and /api/logout are open", async () => {
    for (const p of ["/login", "/api/login", "/api/logout"]) {
      expect((await proxy(request(p))).status, p).toBe(200);
    }
    for (const p of ["/", "/search", "/api/chat", "/api/title", "/api/search", "/api/storage"]) {
      expect((await proxy(request(p))).status, p).not.toBe(200);
    }
  });

  it("a wrong passcode is a 401; no passcode configured fails closed", async () => {
    const wrong = await postLogin("nope");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    delete process.env.LOCUS_PASSCODE;
    const closed = await postLogin("the-passcode");
    expect(closed.status).not.toBe(200);
    expect(closed.headers.get("set-cookie")).toBeNull();
  });
});
