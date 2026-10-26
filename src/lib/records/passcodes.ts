import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Passcodes for named users: scrypt (N=16384, r=8, p=1) with a per-user
 * 16-byte salt, compared in constant time. Only the hash is ever stored.
 * Stored as  scrypt$N$r$p$<salt b64>$<hash b64>.
 */

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function derive(passcode: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passcode.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPasscode(passcode: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(passcode, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPasscode(passcode: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Only parameters scrypt accepts and that are sane to run (a damaged or hand-edited value is just "no").
  const isPow2 = n >= 1024 && n <= 2 ** 20 && (n & (n - 1)) === 0;
  if (!isPow2 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return false;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const expected = Buffer.from(parts[5], "base64");
    const actual = await derive(passcode, salt, n, r, p);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A hash to compare against when the username doesn't exist, so a wrong username and a wrong passcode take the same time. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPasscode("not-a-real-passcode-for-timing"));
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O, 1/l/I

/** A random passcode (12 characters, about 68 bits) for accounts the admin creates or resets. */
export function generatePasscode(length = 12): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const COMMON = new Set(["password", "passcode", "12345678", "123456789", "1234567890", "qwertyui", "qwerty123", "iloveyou", "letmein1", "welcome1", "admin123", "password1", "password123"]);

export function checkPasscodeStrength(passcode: unknown, username?: string): { ok: true } | { ok: false; message: string } {
  if (typeof passcode !== "string") return { ok: false, message: "Choose a passcode." };
  if (passcode.length < 8) return { ok: false, message: "Use at least 8 characters." };
  if (passcode.length > 200) return { ok: false, message: "That passcode is too long (200 characters at most)." };
  if (COMMON.has(passcode.toLowerCase())) return { ok: false, message: "That passcode is too easy to guess." };
  if (username && passcode.toLowerCase() === username.toLowerCase()) return { ok: false, message: "The passcode can't be the same as the username." };
  if (/^(.)\1+$/.test(passcode)) return { ok: false, message: "That passcode is too easy to guess." };
  return { ok: true };
}
