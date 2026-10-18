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

const MAX_PASSCODE_CHARS = 200;

/** Best-effort caller identity for rate limiting; a shared string if none is sent. */
function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: Request) {
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
