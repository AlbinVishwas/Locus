import { constantTimeEqual, createSessionToken, SESSION_COOKIE, sessionTtlMs } from "../auth";
import { callerIp, logActivity } from "../records/activity";
import { getRecordsDb } from "../records/db";
import { createUser, ensureAdminUser, adminPasscodeMatches, findUserByName, recordLogin, UserError, verifyLogin, type Role } from "../records/users";
import { adminEnabled, ADMIN_USERNAME, signupCode, signupMode } from "./mode";
import { adminSignInGlobal, signInByAddress, signInByUsername, signUpByAddress, signUpGlobal } from "./limits";

/**
 * Signing in and signing up in users mode. Everything that can go wrong is
 * answered in plain words, and every attempt -- good or bad -- is written to
 * the activity log (never the typed passcode or sign-up code).
 */

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

export type SignInOutcome = { ok: true; user: SessionUser; cookie: string } | { ok: false; status: number; error: string };

const MAX_FIELD = 200;
const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";

/** How long an admin sign-in lasts: shorter than a user's (LOCUS_ADMIN_SESSION_HOURS, default 8). */
export function adminSessionTtlMs(): number {
  const hours = Number(process.env.LOCUS_ADMIN_SESSION_HOURS ?? 8);
  return (Number.isFinite(hours) && hours > 0 ? hours : 8) * 60 * 60 * 1000;
}

export function sessionCookie(token: string, ttlMs: number): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", `Max-Age=${Math.floor(ttlMs / 1000)}`].join("; ");
}

async function issue(user: SessionUser & { tokenVersion: number }): Promise<{ user: SessionUser; cookie: string }> {
  const ttl = user.role === "admin" ? adminSessionTtlMs() : sessionTtlMs();
  const token = await createSessionToken({ u: user.id, r: user.role, tv: user.tokenVersion }, ttl);
  return { user: { id: user.id, username: user.username, role: user.role }, cookie: sessionCookie(token, ttl) };
}

const asText = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD ? v : null);

export async function signIn(req: Request, input: { username?: unknown; passcode?: unknown }): Promise<SignInOutcome> {
  const db = getRecordsDb();
  const ip = callerIp(req.headers);
  const ua = req.headers.get("user-agent");
  const addressKey = ip ?? "unknown";
  const username = asText(input.username)?.trim() ?? null;
  const passcode = asText(input.passcode);
  if (!username || !passcode) return { ok: false, status: 400, error: "Enter your username and password." };

  const nameKey = username.toLowerCase();
  const isAdminName = nameKey === ADMIN_USERNAME;
  const refuse = (error: string, status: number, message: string, who: string | null) => {
    logActivity(db, { username: who, kind: "login_failed", status: status === 429 ? "refused" : "denied", message, ip, userAgent: ua });
    return { ok: false as const, status, error };
  };

  if (signInByAddress.isLimited(addressKey) || signInByUsername.isLimited(nameKey) || (isAdminName && adminSignInGlobal.isLimited("admin"))) {
    return refuse(TOO_MANY, 429, "too many attempts", isAdminName ? ADMIN_USERNAME : null);
  }

  const fail = (message: string, who: string | null, error = "Wrong username or password.", status = 401) => {
    signInByAddress.record(addressKey);
    signInByUsername.record(nameKey);
    if (isAdminName) adminSignInGlobal.record("admin");
    return refuse(error, status, message, who);
  };

  if (isAdminName) {
    // Admin: the passcode in .env.local. With none set, admin sign-in is closed and looks like any wrong passcode.
    if (!adminEnabled() || !adminPasscodeMatches(passcode)) {
      return fail(adminEnabled() ? "wrong admin passcode" : "admin sign-in is not set up", ADMIN_USERNAME);
    }
    const admin = await ensureAdminUser(db);
    signInByAddress.clear(addressKey);
    signInByUsername.clear(nameKey);
    recordLogin(db, admin.id);
    logActivity(db, { userId: admin.id, username: admin.username, role: "admin", kind: "login", ip, userAgent: ua });
    return { ok: true, ...(await issue(admin)) };
  }

  const result = await verifyLogin(db, username, passcode);
  // Only an attempted name that is a real account is logged by name: people sometimes type their
  // passcode into the username box, and that must not end up in the log.
  const known = findUserByName(db, username)?.username ?? null;
  if (!result.ok) {
    if (result.reason === "disabled") return fail("account disabled", known, "This account has been disabled. Ask the administrator.", 403);
    return fail(known ? "wrong passcode" : "unknown username", known);
  }
  signInByAddress.clear(addressKey);
  signInByUsername.clear(nameKey);
  recordLogin(db, result.user.id);
  logActivity(db, { userId: result.user.id, username: result.user.username, role: "user", kind: "login", ip, userAgent: ua });
  return { ok: true, ...(await issue(result.user)) };
}

export async function signUp(req: Request, input: { username?: unknown; passcode?: unknown; code?: unknown }): Promise<SignInOutcome> {
  const db = getRecordsDb();
  const ip = callerIp(req.headers);
  const ua = req.headers.get("user-agent");
  const addressKey = ip ?? "unknown";
  const log = (status: "ok" | "denied" | "refused" | "error", message: string | null, who?: SessionUser | null) =>
    logActivity(db, {
      userId: who?.id ?? null,
      username: who?.username ?? null,
      role: who?.role ?? null,
      kind: status === "ok" ? "signup" : "signup_failed",
      status,
      message,
      ip,
      userAgent: ua,
    });

  const mode = signupMode();
  if (mode === "off") {
    log("refused", "sign-up is closed");
    return { ok: false, status: 403, error: "Sign-up is closed. Ask the administrator for an account." };
  }
  const required = signupCode();
  if (mode === "code" && required === null) {
    log("refused", "no sign-up code is set");
    return { ok: false, status: 403, error: "Sign-up isn't open yet: the administrator hasn't set a sign-up code." };
  }
  if (signUpByAddress.isLimited(addressKey) || signUpGlobal.isLimited("all")) {
    log("refused", "too many sign-ups");
    return { ok: false, status: 429, error: "Too many sign-up attempts. Try again later." };
  }
  // Every attempt counts, successful or not: this is what stops a script minting accounts.
  signUpByAddress.record(addressKey);
  signUpGlobal.record("all");

  if (mode === "code") {
    const code = asText(input.code);
    if (!code || !constantTimeEqual(code, required!)) {
      log("denied", "wrong sign-up code");
      return { ok: false, status: 403, error: "That sign-up code isn't right." };
    }
  }
  try {
    const user = await createUser(db, { username: input.username, passcode: input.passcode, createdBy: "signup" });
    recordLogin(db, user.id);
    log("ok", null, user);
    return { ok: true, ...(await issue(user)) };
  } catch (err) {
    if (err instanceof UserError) {
      log("denied", err.message);
      return { ok: false, status: err.code === "taken" ? 409 : 400, error: err.message };
    }
    throw err;
  }
}
