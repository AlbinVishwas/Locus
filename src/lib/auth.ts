/**
 * Shared-passcode auth for Locus.
 *
 * There is one passcode (set by whoever runs the app, in `.env.local`), not
 * per-user accounts. A session is a signed, expiring token in an httpOnly
 * cookie. "Signed" means tamper-evident, not confidential: the payload is
 * just an expiry timestamp, so there is nothing in it worth encrypting.
 *
 * Built on Web Crypto (`crypto.subtle`) rather than `node:crypto` so the same
 * code runs in both the Node API routes and the Edge-runtime middleware that
 * guards every page and route.
 */

import { envWithFallback } from "./env";

export const SESSION_COOKIE = "locus_session";

const DEFAULT_SESSION_TTL_HOURS = 24 * 7; // a week
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Reads the configured passcode. Returns null when it isn't set, which
 * means every login attempt fails — the app stays locked rather than
 * falling back to "no passcode required".
 */
export function getPasscode(): string | null {
  const value = envWithFallback("LOCUS_PASSCODE", "ASSAY_PASSCODE");
  return value && value.length > 0 ? value : null;
}

export function sessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
  const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_TTL_HOURS;
  return safe * 60 * 60 * 1000;
}

/**
 * Signing key for session tokens. In development, when `SESSION_SECRET`
 * isn't set, one is generated per process start and kept only in memory --
 * a safe default for local iteration (nothing to leak, nothing to
 * configure to get started) at the cost that restarting the server
 * invalidates every existing session.
 *
 * In production this per-process fallback is refused outright, not just
 * warned about: the proxy (Edge runtime) and API routes (Node runtime) are
 * separate module instances, so each would generate its *own* fallback and
 * silently diverge -- every login would then fail signature verification
 * while looking, from the login page, like the request simply never
 * finished. `npm run share` generates and persists a real SESSION_SECRET
 * before it ever starts the server (see scripts/share.ts), so this only
 * fires for a production server started some other way without one set.
 */
let generatedSecret: string | null = null;
function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length > 0) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is not set. A production server needs one explicit value shared by " +
        "every runtime, not a per-process fallback (the Edge proxy and Node routes would each " +
        "generate their own and no login would ever succeed). Generate one with " +
        '`node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"` and set SESSION_SECRET ' +
        "in .env.local, or just run `npm run share`, which does this for you."
    );
  }

  if (!generatedSecret) {
    generatedSecret = crypto.randomUUID() + crypto.randomUUID();
    console.warn(
      "[auth] SESSION_SECRET is not set; generated a temporary one for this " +
        "process. Sessions will not survive a restart. Set SESSION_SECRET in " +
        ".env.local to avoid that."
    );
  }
  return generatedSecret;
}

/**
 * Constant-time string comparison. Used for the passcode check so a
 * character-by-character timing difference can't leak how much of a guess
 * was correct. `node:crypto`'s `timingSafeEqual` requires equal-length
 * buffers and isn't available in the Edge runtime, so this is a small,
 * dependency-free equivalent: it always walks the full length of the longer
 * string regardless of where the first mismatch is.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLength; i++) {
    const charA = a.charCodeAt(i) || 0;
    const charB = b.charCodeAt(i) || 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toBase64Url(signature);
}

/** Builds a new session token good for `sessionTtlMs()` from now. */
export async function createSessionToken(): Promise<string> {
  const payload = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ exp: Date.now() + sessionTtlMs() }))
  );
  const signature = await hmac(payload);
  return `${payload}.${signature}`;
}

/**
 * Verifies a session token's signature and expiry. Never throws: a
 * malformed, tampered, or expired token is just "not valid", the same as a
 * missing one.
 */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  let expectedSignature: string;
  try {
    expectedSignature = await hmac(payload);
  } catch {
    return false;
  }
  if (!constantTimeEqual(signature, expectedSignature)) return false;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as {
      exp?: number;
    };
    return typeof decoded.exp === "number" && Date.now() < decoded.exp;
  } catch {
    return false;
  }
}

type RateLimitEntry = { count: number; windowStart: number };

/**
 * Per-process, in-memory login rate limiter keyed by caller IP. This is
 * intentionally simple: Locus runs as one Node process on one laptop, so
 * there's no multi-instance state to share. It resets on restart, which is
 * an acceptable trade for not adding a datastore just to throttle a login
 * form.
 */
const loginAttempts = new Map<string, RateLimitEntry>();

export function isRateLimited(key: string): boolean {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function recordFailedLogin(key: string): void {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: Date.now() });
    return;
  }
  entry.count += 1;
}

export function clearLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}

/** Test-only: drops all rate-limit state between test cases. */
export function _resetRateLimitsForTests(): void {
  loginAttempts.clear();
}
