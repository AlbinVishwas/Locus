import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorPage from "@/components/ErrorPage";
import NotFound from "@/app/not-found";
import ProblemPage from "@/app/problem/[code]/page";
import { codeOf, ERRORS, errorBody, errorResponse, isErrorCode, withCode, type ErrorCode } from "./catalog";
import { redact } from "./redact";

describe("error catalog", () => {
  const codes = Object.keys(ERRORS) as ErrorCode[];

  it("every entry has a unique code in the LOCUS-AREA-NNN form, a title, a plain message and something to do", () => {
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^LOCUS-[A-Z]+-\d{3}$/);
      const e = ERRORS[code];
      expect(e.title.length, code).toBeGreaterThan(3);
      expect(e.message.length, code).toBeGreaterThan(20);
      expect(e.action.length, code).toBeGreaterThan(10);
      expect([200, 401, 403, 404, 500, 503, 504, 507]).toContain(e.status);
      // Plain English: no stack frames, file paths or SQL in what people read.
      expect(`${e.title} ${e.message} ${e.action}`, code).not.toMatch(/\bat \w+\.\w+ \(|\.ts:\d+|SQLITE_|Error:/);
    }
  });

  it("covers the situations the app has pages for", () => {
    for (const code of ["LOCUS-AUTH-001", "LOCUS-AUTH-002", "LOCUS-NOTFOUND-001", "LOCUS-SERVER-001", "LOCUS-DISK-001", "LOCUS-DISK-002", "LOCUS-INDEX-001", "LOCUS-APP-001", "LOCUS-APP-002"] as const) expect(isErrorCode(code)).toBe(true);
  });

  it("API errors are {code, message} JSON with the right status, never a stack trace", async () => {
    const res = errorResponse("LOCUS-SERVER-001");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["action", "code", "message"]);
    expect(body.code).toBe("LOCUS-SERVER-001");
    expect(errorBody("LOCUS-DISK-001", "needs 10 GB")).toMatchObject({ detail: "needs 10 GB" });
  });

  it("withCode / codeOf round-trip a code through a plain message", () => {
    const m = withCode("LOCUS-DISK-001", "Needs 10 GB.");
    expect(m).toMatch(/^LOCUS-DISK-001: Not enough disk space/);
    expect(codeOf(m)).toBe("LOCUS-DISK-001");
    expect(codeOf("something else")).toBeNull();
    expect(codeOf("LOCUS-NOPE-999: x")).toBeNull();
  });
});

describe("error pages render", () => {
  it("404 (not-found.tsx) says the page isn't there, with a way back and its code", () => {
    const html = renderToStaticMarkup(NotFound());
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain("LOCUS-NOTFOUND-001");
  });

  it("every catalog code renders as a /problem page with its title, message, action and code", async () => {
    for (const code of Object.keys(ERRORS) as ErrorCode[]) {
      const html = renderToStaticMarkup(await ProblemPage({ params: Promise.resolve({ code: code.toLowerCase() }) }));
      expect(html, code).toContain(ERRORS[code].title.replace(/'/g, "&#x27;"));
      expect(html, code).toContain(code);
      expect(html, code).toContain("<h1");
    }
  });

  it("not signed in, no access, server unreachable, storage full, index building and maintenance all have a page", async () => {
    for (const [code, text] of [
      ["LOCUS-AUTH-001", "Please sign in"],
      ["LOCUS-AUTH-002", "No access"],
      ["LOCUS-SERVER-001", "Can&#x27;t reach the storage server"],
      ["LOCUS-DISK-001", "Not enough disk space to build the index"],
      ["LOCUS-UPLOAD-002", "Storage is full"],
      ["LOCUS-INDEX-001", "The index is still being built"],
      ["LOCUS-APP-002", "under maintenance"],
    ] as const) {
      expect(renderToStaticMarkup(await ProblemPage({ params: Promise.resolve({ code }) })), code).toContain(text);
    }
  });

  it("an unknown code is a 404, and the generic crash page shows a reference but no technical details", async () => {
    await expect(ProblemPage({ params: Promise.resolve({ code: "nope" }) })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/);
    const html = renderToStaticMarkup(<ErrorPage code="LOCUS-APP-001" reference="abc123" />);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("reference abc123");
    expect(html).not.toMatch(/stack|TypeError|node_modules/);
  });
});

describe("secrets are redacted before anything is logged", () => {
  it("removes the literal secret settings and anything that looks like a credential", () => {
    const env = { LOCUS_SERVER_S3_SECRET_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", LOCUS_SERVER_S3_ACCESS_KEY: "AKIAIOSFODNN7EXAMPLE", SESSION_SECRET: "abcdef0123456789" };
    const text = `S3 failed: key AKIAIOSFODNN7EXAMPLE secret wJalrXUtnFEMI/K7MDENG/bPxRfiCY session abcdef0123456789 password=hunter22 Authorization: Bearer xyz X-Amz-Signature=deadbeef`;
    const out = redact(text, env);
    for (const leak of ["AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI", "abcdef0123456789", "hunter22", "xyz", "deadbeef"]) expect(out, leak).not.toContain(leak);
    expect(out).toContain("[redacted]");
  });
});
