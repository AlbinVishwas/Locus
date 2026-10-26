import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Sealing database passwords. AES-256-GCM, with the key derived (HKDF-SHA-256)
 * from LOCUS_SECRETS_KEY in .env.local, a fresh random 96-bit nonce per
 * secret, and the source's id as the authenticated data -- so a sealed
 * password copied onto a different source fails to open instead of quietly
 * working there.
 *
 * Stored form (base64url): version(1) | key id(4) | nonce(12) | ciphertext | tag(16).
 * The key id is the first 4 bytes of SHA-256(key), so "wrong key" can be told
 * apart from "tampered".
 *
 * A sealed secret is never returned to the browser and never logged; callers
 * open it only at the moment a connection is made.
 */

const VERSION = 1;
const MIN_KEY_CHARS = 32;

export type SecretErrorCode = "no-key" | "weak-key" | "wrong-key" | "tampered" | "malformed";

export class SecretError extends Error {
  constructor(
    readonly code: SecretErrorCode,
    message: string
  ) {
    super(message);
  }
}

export function secretsKeyFromEnv(env: Record<string, string | undefined> = process.env): string {
  const key = env.LOCUS_SECRETS_KEY?.trim();
  if (!key) {
    throw new SecretError("no-key", "Set LOCUS_SECRETS_KEY in .env.local first (a long random string): saved passwords are encrypted with it.");
  }
  if (key.length < MIN_KEY_CHARS) {
    throw new SecretError("weak-key", `LOCUS_SECRETS_KEY must be at least ${MIN_KEY_CHARS} characters. Generate one with: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`);
  }
  return key;
}

function derive(key: string): { aesKey: Buffer; keyId: Buffer } {
  const aesKey = Buffer.from(hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.from("locus-secrets-v1"), Buffer.from("sealing key"), 32));
  const keyId = createHash("sha256").update(key).digest().subarray(0, 4);
  return { aesKey, keyId };
}

export function sealSecret(plaintext: string, aad: string, key: string = secretsKeyFromEnv()): string {
  const { aesKey, keyId } = derive(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), keyId, nonce, ciphertext, tag]).toString("base64url");
}

export function openSecret(blob: string, aad: string, key: string = secretsKeyFromEnv()): string {
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64url");
  } catch {
    throw new SecretError("malformed", "The saved password is damaged.");
  }
  if (raw.length < 1 + 4 + 12 + 16 || raw[0] !== VERSION) throw new SecretError("malformed", "The saved password is damaged.");
  const { aesKey, keyId } = derive(key);
  if (!raw.subarray(1, 5).equals(keyId)) {
    throw new SecretError("wrong-key", "This password was saved with a different LOCUS_SECRETS_KEY. Enter it again.");
  }
  const nonce = raw.subarray(5, 17);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(17, raw.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("tampered", "The saved password can't be read (it was changed, or belongs to another source). Enter it again.");
  }
}
