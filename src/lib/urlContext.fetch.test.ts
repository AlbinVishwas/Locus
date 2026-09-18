import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both the DNS resolver and fetch are mocked so the redirect-chain behaviour
// can be exercised deterministically and offline. The SSRF guard resolves
// hostnames itself, so the resolver is what decides "public" vs "private".
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === "public.example") return [{ address: "93.184.216.34" }];
    if (hostname === "evil.example") return [{ address: "127.0.0.1" }];
    if (hostname === "127.0.0.1") return [{ address: "127.0.0.1" }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

const { fetchPageContent } = await import("./urlContext");

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });

const redirectTo = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("redirect handling", () => {
  it("follows redirects and extracts the final page", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("https://public.example/two"))
      .mockResolvedValueOnce(redirectTo("/three"))
      .mockResolvedValueOnce(html(`<html><body><p>${"final content ".repeat(10)}</p></body></html>`));

    const result = await fetchPageContent("https://public.example/one");

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected the page to be read");
    expect(result.content).toContain("final content");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resolves a relative Location against the hop it came from", async () => {
    fetchMock
      .mockResolvedValueOnce(redirectTo("/moved"))
      .mockResolvedValueOnce(html(`<html><body><p>${"ok ".repeat(40)}</p></body></html>`));

    await fetchPageContent("https://public.example/deep/page");

    expect(fetchMock.mock.calls[1][0]).toBe("https://public.example/moved");
  });

  it("gives up after more than five hops", async () => {
    fetchMock.mockResolvedValue(redirectTo("https://public.example/loop"));

    const result = await fetchPageContent("https://public.example/loop");

    expect(result).toMatchObject({
      ok: false,
      reason: "the URL redirected more than 5 times",
    });
  });

  it("reports a redirect that carries no Location header", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const result = await fetchPageContent("https://public.example/x");

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a failure");
    expect(result.reason).toContain("no redirect target");
  });

  it("does not chase a 304, which is 3xx but not a redirect", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { location: "https://public.example/other" } })
    );

    await fetchPageContent("https://public.example/x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SSRF guard on every hop", () => {
  it("blocks a public URL that redirects to loopback", async () => {
    // The whole reason redirects are followed by hand: with redirect:"follow"
    // this hop would never be checked.
    fetchMock.mockResolvedValueOnce(redirectTo("http://127.0.0.1:1234/v1/models"));

    const result = await fetchPageContent("https://public.example/start");

    expect(result).toMatchObject({
      ok: false,
      reason: "the URL points to a private or local network address",
    });
    // The blocked host was never actually requested.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets a public IPv6 literal through to the fetch", async () => {
    // Proves the address check distinguishes public from private rather than
    // blocking every bracketed address. Offline on purpose: the earlier
    // version made a real request and was flaky without IPv6 routing.
    fetchMock.mockResolvedValueOnce(
      html(`<html><body><p>${"public v6 ".repeat(10)}</p></body></html>`)
    );

    const result = await fetchPageContent(
      "http://[2606:2800:220:1:248:1893:25c8:1946]/x"
    );

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks a public hostname that resolves to loopback", async () => {
    const result = await fetchPageContent("https://evil.example/x");

    expect(result).toMatchObject({
      ok: false,
      reason: "the URL points to a private or local network address",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("response handling", () => {
  it("rejects a non-HTML content type without reading the body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );

    const result = await fetchPageContent("https://public.example/api");

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a failure");
    expect(result.reason).toContain("not HTML");
  });

  it("reports an HTTP error status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503, statusText: "Service Unavailable" }));

    const result = await fetchPageContent("https://public.example/down");

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a failure");
    expect(result.reason).toContain("503");
  });

  it("surfaces a network error as a reason rather than throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    const result = await fetchPageContent("https://public.example/x");

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected a failure");
    expect(result.reason).toContain("socket hang up");
  });
});
