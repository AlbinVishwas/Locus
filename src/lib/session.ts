import { readSessionToken, SESSION_COOKIE } from "./auth";
import { logActivity, callerIp, type ActivityInput } from "./records/activity";
import { getRecordsDb } from "./records/db";
import { claimConversation } from "./records/ownership";
import { ensureAdminUser, getUser } from "./records/users";
import type { SessionUser } from "./users/signin";
import { adminEnabled, userSourcesEnabled, usersEnabled } from "./users/mode";

/**
 * Who is making this request, checked on the server for every route that
 * needs to know -- never taken from the browser's word. In users mode the
 * session cookie names the user; the user is looked up each time, so
 * disabling an account or resetting its passcode takes effect at the next
 * request, not when the cookie expires.
 */

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export async function currentUser(req: Request): Promise<SessionUser | null> {
  if (!usersEnabled()) return null;
  return userFromToken(cookieValue(req, SESSION_COOKIE));
}

/** Same check from a raw cookie value (server components read cookies through next/headers). */
export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!usersEnabled()) return null;
  const claims = await readSessionToken(token);
  if (!claims || claims.u === undefined || claims.tv === undefined) return null;
  const db = getRecordsDb();
  const user = getUser(db, claims.u);
  if (!user || user.disabledAt) return null;
  // The admin account's passcode lives in .env.local: if that changed, this bumps the version first.
  const effective = user.role === "admin" ? await ensureAdminUser(db) : user;
  if (effective.tokenVersion !== claims.tv || claims.r !== effective.role) return null;
  return { id: effective.id, username: effective.username, role: effective.role };
}

const json = (status: number, error: string) => Response.json({ error }, { status });

export type Gate = { ok: true; user: SessionUser | null } | { ok: false; response: Response };

/** Any signed-in user (users mode); a no-op with users mode off. */
export async function requireUser(req: Request): Promise<Gate> {
  if (!usersEnabled()) return { ok: true, user: null };
  const user = await currentUser(req);
  return user ? { ok: true, user } : { ok: false, response: json(401, "Not authenticated") };
}

/** A state-changing request from this site only: refuses a cross-site form post or fetch. */
function sameOrigin(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      if (host && new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The checks every state-changing admin/sources request gets: this site only, and JSON for anything with a body. */
function requestChecks(req: Request): Response | null {
  if (!sameOrigin(req)) return json(403, "Cross-site request refused");
  if (!["GET", "HEAD", "DELETE"].includes(req.method) && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json(415, "Send JSON");
  }
  return null;
}

/**
 * The admin area. Not found when it isn't set up (users mode with an admin
 * passcode); otherwise only the admin, only from this site, and for anything
 * that sends a body, only as JSON.
 */
export async function requireAdmin(req: Request): Promise<Gate> {
  if (!adminEnabled()) return { ok: false, response: json(404, "Not found") };
  const user = await currentUser(req);
  if (!user) return { ok: false, response: json(401, "Not authenticated") };
  if (user.role !== "admin") {
    logActivity(getRecordsDb(), activityFor(req, user, { kind: "access_denied", status: "denied", message: `admin area: ${new URL(req.url).pathname}` }));
    return { ok: false, response: json(403, "Admins only") };
  }
  const refused = requestChecks(req);
  if (refused) return { ok: false, response: refused };
  return { ok: true, user };
}

/**
 * The library and Sources area: the administrator (everything), and -- only with LOCUS_USER_SOURCES=true --
 * ordinary accounts, who then see and manage only their own folders. The route decides what each may do;
 * this only says who gets in.
 */
export async function requireSourcesAccess(req: Request): Promise<Gate> {
  if (!usersEnabled()) return { ok: false, response: json(404, "Not found") };
  const user = await currentUser(req);
  if (!user) return { ok: false, response: json(401, "Not authenticated") };
  if (user.role === "admin") return requireAdmin(req);
  if (!userSourcesEnabled()) {
    logActivity(getRecordsDb(), activityFor(req, user, { kind: "access_denied", status: "denied", message: `admin area: ${new URL(req.url).pathname}` }));
    return { ok: false, response: json(403, "Admins only") };
  }
  const refused = requestChecks(req);
  if (refused) return { ok: false, response: refused };
  return { ok: true, user };
}

/**
 * Whether `user` may use session `conversationId`: the first signed-in user
 * to use an id owns it, and anyone else gets "No such session" -- the same
 * answer as for an id that doesn't exist, so ids can't be probed. With users
 * mode off this is a no-op.
 */
export async function authorizeConversation(req: Request, conversationId: string): Promise<Gate> {
  const gate = await requireUser(req);
  if (!gate.ok || gate.user === null) return gate;
  const db = getRecordsDb();
  const owner = claimConversation(db, conversationId, gate.user.id);
  if (owner !== gate.user.id) {
    logActivity(db, activityFor(req, gate.user, { kind: "access_denied", status: "denied", message: "tried to use a session that belongs to someone else", details: { route: new URL(req.url).pathname } }));
    return { ok: false, response: json(404, "No such session") };
  }
  return gate;
}

/** Fills in who/where for an activity row from the request. */
export function activityFor(req: Request, user: SessionUser | null, a: ActivityInput): ActivityInput {
  return { userId: user?.id ?? null, username: user?.username ?? null, role: user?.role ?? null, ip: callerIp(req.headers), userAgent: req.headers.get("user-agent"), ...a };
}
