import { describe, expect, it } from "vitest";
import { sanitizeOriginalFilename, validateUploadBytes } from "./validate";

describe("validateUploadBytes", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("rest of file")]);

  it("accepts real PDF bytes under the limit", () => {
    expect(validateUploadBytes(pdf, 1024)).toEqual({ ok: true });
  });

  it("rejects an empty file", () => {
    expect(validateUploadBytes(Buffer.alloc(0), 1024)).toMatchObject({ ok: false });
  });

  it("rejects a file over the size limit", () => {
    const big = Buffer.concat([pdf, Buffer.alloc(2000)]);
    const result = validateUploadBytes(big, 1024);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("limit");
  });

  it("rejects a non-PDF, even one renamed to end in .pdf", () => {
    const fakePdf = Buffer.from("MZ\x90\x00this is actually an exe, just renamed");
    expect(validateUploadBytes(fakePdf, 1024)).toMatchObject({ ok: false });
  });

  it("rejects a PNG with a .pdf extension (checked by content, not name)", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(validateUploadBytes(png, 1024)).toMatchObject({ ok: false });
  });
});

describe("sanitizeOriginalFilename", () => {
  it("passes through an ordinary filename", () => {
    expect(sanitizeOriginalFilename("Tender Notice.pdf")).toBe("Tender Notice.pdf");
  });

  it("falls back to a default for an empty or control-character-only name", () => {
    expect(sanitizeOriginalFilename("")).toBe("document.pdf");
    expect(sanitizeOriginalFilename("\u0000\u0001")).toBe("document.pdf");
  });

  it("strips control characters but keeps the rest", () => {
    expect(sanitizeOriginalFilename("a\u0000b.pdf")).toBe("ab.pdf");
  });

  it("never produces a path -- a path-traversal name is just a long, odd filename, not a path", () => {
    const traversal = "../../../../etc/passwd.pdf";
    // sanitizeOriginalFilename intentionally doesn't need to defend against
    // this: the result is stored as a display string and never used to
    // build a filesystem path (storage.ts is content-addressed), so a
    // literal "../" surviving here is not a vulnerability.
    expect(sanitizeOriginalFilename(traversal)).toBe(traversal);
  });

  it("truncates a very long filename", () => {
    const long = "a".repeat(500) + ".pdf";
    expect(sanitizeOriginalFilename(long).length).toBe(200);
  });
});
