import { describe, expect, it } from "vitest";
import { openSecret, SecretError, sealSecret, secretsKeyFromEnv } from "./secrets";

const KEY = "k".repeat(40);
const OTHER = "z".repeat(40);

describe("sealed secrets", () => {
  it("round-trips, and the stored form contains neither the password nor anything readable", () => {
    const blob = sealSecret("hunter2-correct-horse", "source-1", KEY);
    expect(blob).not.toContain("hunter2");
    expect(Buffer.from(blob, "base64url").toString("latin1")).not.toContain("hunter2");
    expect(openSecret(blob, "source-1", KEY)).toBe("hunter2-correct-horse");
  });

  it("a fresh nonce each time: sealing the same password twice gives different blobs", () => {
    expect(sealSecret("same", "s", KEY)).not.toBe(sealSecret("same", "s", KEY));
  });

  it("handles empty, long and non-ASCII passwords", () => {
    for (const pw of ["", "x".repeat(10_000), "pässwörd ✓ पासवर्ड", "quote\"and'semi;colon"]) {
      expect(openSecret(sealSecret(pw, "s", KEY), "s", KEY)).toBe(pw);
    }
  });

  it("a blob copied onto another source fails (the source id is authenticated)", () => {
    const blob = sealSecret("pw", "source-1", KEY);
    expect(() => openSecret(blob, "source-2", KEY)).toThrowError(expect.objectContaining({ code: "tampered" }));
  });

  it("the wrong key is told apart from tampering", () => {
    const blob = sealSecret("pw", "s", KEY);
    expect(() => openSecret(blob, "s", OTHER)).toThrowError(expect.objectContaining({ code: "wrong-key" }));
  });

  it("any flipped byte is detected", () => {
    const raw = Buffer.from(sealSecret("pw-to-protect", "s", KEY), "base64url");
    for (const i of [raw.length - 1, raw.length - 20, 20]) {
      const copy = Buffer.from(raw);
      copy[i] ^= 0x01;
      expect(() => openSecret(copy.toString("base64url"), "s", KEY), `byte ${i}`).toThrow(SecretError);
    }
  });

  it("garbage and truncated blobs are 'malformed'", () => {
    for (const bad of ["", "abc", Buffer.alloc(10).toString("base64url"), Buffer.concat([Buffer.from([9]), Buffer.alloc(40)]).toString("base64url")]) {
      expect(() => openSecret(bad, "s", KEY)).toThrowError(expect.objectContaining({ code: "malformed" }));
    }
  });

  it("no key, or a weak one, is refused with a message that says what to do", () => {
    expect(() => secretsKeyFromEnv({})).toThrowError(expect.objectContaining({ code: "no-key", message: expect.stringContaining("LOCUS_SECRETS_KEY") }));
    expect(() => secretsKeyFromEnv({ LOCUS_SECRETS_KEY: "short" })).toThrowError(expect.objectContaining({ code: "weak-key" }));
    expect(secretsKeyFromEnv({ LOCUS_SECRETS_KEY: `  ${KEY}  ` })).toBe(KEY);
  });
});
