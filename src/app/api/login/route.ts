import {
  SESSION_COOKIE,
  clearLoginAttempts,
  constantTimeEqual,
  createSessionToken,
  getPasscode,
  isRateLimited,
  recordFailedLogin,
  sessionTtlMs,
} from "@/lib/auth";

import { signIn } from "@/lib/users/signin";
import { signupCode, signupMode, usersEnabled } from "@/lib/users/mode";

const MAX_PASSCODE_CHARS = 200;

/** Users mode: a username and a passcode, checked against the account (or the admin passcode for "admin"). */
async function usersLogin(req: Request): Promise<Response> {
  let body: { username?: unknown; passcode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  const outcome = await signIn(req, body ?? {});
  if (!outcome.ok) return Response.json({ ok: false, error: outcome.error }, { status: outcome.status });
  const res = Response.json({ ok: true, role: outcome.user.role });
  res.headers.append("Set-Cookie", outcome.cookie);
  return res;
}

/** Best-effort caller identity for rate limiting; a shared string if none is sent. */
function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/** What the sign-in page needs to know: one shared passcode (as always), or named users, and whether people can sign up. */
export async function GET() {
  if (!usersEnabled()) return Response.json({ usersEnabled: false }, { headers: { "Cache-Control": "no-store" } });
  let signup: "code" | "open" | "off" = "off";
  try {
    signup = signupMode();
    if (signup === "code" && signupCode() === null) signup = "off";
  } catch {
    signup = "off";
  }
  return Response.json({ usersEnabled: true, signup }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (usersEnabled()) return usersLogin(req);
  const key = clientKey(req);
  if (isRateLimited(key)) {
    return Response.json(
      { ok: false, error: "Too many attempts. Wait a few minutes and try again." },
      { status: 429 }
    );
  }

  let passcode: unknown;
  try {
    const body = await req.json();
    passcode = (body as { passcode?: unknown })?.passcode;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  if (typeof passcode !== "string" || passcode.length === 0 || passcode.length > MAX_PASSCODE_CHARS) {
    return Response.json({ ok: false, error: "Enter the passcode" }, { status: 400 });
  }

  const configured = getPasscode();
  // No configured passcode means the app stays locked rather than open: a
  // comparison against null would otherwise need its own "always false"
  // special case that's easy to get backwards.
  const valid = configured !== null && constantTimeEqual(passcode, configured);

  if (!valid) {
    recordFailedLogin(key);
    return Response.json({ ok: false, error: "Wrong passcode" }, { status: 401 });
  }

  clearLoginAttempts(key);
  const token = await createSessionToken();

  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${Math.floor(sessionTtlMs() / 1000)}`,
    ].join("; ")
  );
  return res;
}
