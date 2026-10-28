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

/**
 * The admin password as a hash (LOCUS_ADMIN_PASSCODE_HASH, a "scrypt$..." string written by `npm run setup`), for people
 * who would rather not keep the password itself in .env.local. LOCUS_ADMIN_PASSCODE, when also set, wins.
 */
export function adminPasscodeHash(env: Env = process.env): string | null {
  const h = env.LOCUS_ADMIN_PASSCODE_HASH?.trim();
  return h && h.startsWith("scrypt$") ? h : null;
}

/** The admin area (Server, Sources, Users, Activity) exists only in users mode with an admin passcode (or its hash) set. */
export function adminEnabled(env: Env = process.env): boolean {
  return usersEnabled(env) && (adminPasscode(env) !== null || adminPasscodeHash(env) !== null);
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

/** Per-user upload limit in bytes (users mode), under the shared cap. Default 20 GB (LOCUS_USER_UPLOAD_MB=20000). */
export function userUploadLimitBytes(env: Env = process.env): number {
  const raw = env.LOCUS_USER_UPLOAD_MB;
  if (raw === undefined || raw.trim() === "") return 20_000 * 1024 * 1024;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`LOCUS_USER_UPLOAD_MB must be a positive number, got "${raw}"`);
  return n * 1024 * 1024;
}

/**
 * Whether ordinary accounts may add their own folders as sources (the "My folders" page and the folder search
 * scopes). Off unless LOCUS_USER_SOURCES=true, and only in users mode. A user's folders are private to them:
 * only they (and the administrator) can search them.
 */
export function userSourcesEnabled(env: Env = process.env): boolean {
  return usersEnabled(env) && flag(env.LOCUS_USER_SOURCES);
}

/**
 * Whether ordinary accounts may also add a database as a source (on top of folders): LOCUS_USER_DATABASES=true,
 * and only with LOCUS_USER_SOURCES on. A testing switch: the account supplies the host to connect to, so leave
 * it off wherever people shouldn't be able to point this computer at other machines.
 */
export function userDatabasesEnabled(env: Env = process.env): boolean {
  return userSourcesEnabled(env) && flag(env.LOCUS_USER_DATABASES);
}

/** The kinds of source an ordinary account may add. */
export function userSourceKinds(env: Env = process.env): Array<"folder" | "database"> {
  return userDatabasesEnabled(env) ? ["folder", "database"] : ["folder"];
}

/** How many folders one ordinary account may add. */
export function userSourcesMax(env: Env = process.env): number {
  const raw = env.LOCUS_USER_SOURCES_MAX;
  if (raw === undefined || raw.trim() === "") return 5;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`LOCUS_USER_SOURCES_MAX must be a whole number of at least 1, got "${raw}"`);
  return n;
}

export const ADMIN_USERNAME = "admin";
