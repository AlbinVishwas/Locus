/**
 * Users mode: named accounts instead of one shared passcode. Off unless
 * LOCUS_USERS_ENABLED=true; with it off, Locus is exactly the one-passcode
 * app it has always been. Edge-safe (reads env only): the proxy uses it too.
 */

type Env = Record<string, string | undefined>;

const flag = (v: string | undefined) => {
  const t = v?.trim().toLowerCase();
  return t === "true" || t === "1";
};

export function usersEnabled(env: Env = process.env): boolean {
  return flag(env.LOCUS_USERS_ENABLED);
}

export type SignupMode = "code" | "open" | "off";

/** Who may create an account: only people given the sign-up code (default), anyone, or nobody. */
export function signupMode(env: Env = process.env): SignupMode {
  const raw = (env.LOCUS_SIGNUP ?? "code").trim().toLowerCase();
  if (raw === "open" || raw === "off" || raw === "code") return raw;
  throw new Error(`LOCUS_SIGNUP must be "code", "open" or "off", got "${raw}"`);
}

/** The code people need to sign up: LOCUS_SIGNUP_CODE, else the shared passcode the app used before accounts. Null = sign-up closed. */
export function signupCode(env: Env = process.env): string | null {
  const code = env.LOCUS_SIGNUP_CODE?.trim() || env.LOCUS_PASSCODE?.trim() || env.ASSAY_PASSCODE?.trim();
  return code ? code : null;
}

export function adminPasscode(env: Env = process.env): string | null {
  const p = env.LOCUS_ADMIN_PASSCODE;
  return p && p.length > 0 ? p : null;
}

/** The admin area (Sources, Users, Activity) exists only in users mode with an admin passcode set. */
export function adminEnabled(env: Env = process.env): boolean {
  return usersEnabled(env) && adminPasscode(env) !== null;
}

/** Whether searches' text goes in the activity log (admin-only). LOCUS_LOG_QUERY_TEXT=false keeps everything else but not the text. */
export function logQueryText(env: Env = process.env): boolean {
  return (env.LOCUS_LOG_QUERY_TEXT ?? "true").trim().toLowerCase() !== "false";
}

export function activityRetentionDays(env: Env = process.env): number {
  const raw = env.LOCUS_ACTIVITY_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return 365;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`LOCUS_ACTIVITY_RETENTION_DAYS must be a positive number, got "${raw}"`);
  return n;
}

/** Per-user upload limit in bytes (users mode), under the shared cap. */
export function userUploadLimitBytes(env: Env = process.env): number {
  const raw = env.LOCUS_USER_UPLOAD_MB;
  if (raw === undefined || raw.trim() === "") return 1000 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`LOCUS_USER_UPLOAD_MB must be a positive number, got "${raw}"`);
  return n * 1024 * 1024;
}

export const ADMIN_USERNAME = "admin";
