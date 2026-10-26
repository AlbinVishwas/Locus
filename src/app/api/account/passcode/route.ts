import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { changeOwnPasscode, UserError } from "@/lib/records/users";
import { activityFor, requireUser } from "@/lib/session";
import { sessionCookie } from "@/lib/users/signin";
import { createSessionToken, sessionTtlMs } from "@/lib/auth";

export const runtime = "nodejs";

/** A signed-in user changes their own passcode (must give the current one). Their other devices are signed out; this one gets a fresh sign-in. */
export async function POST(req: Request) {
  const gate = await requireUser(req);
  if (!gate.ok) return gate.response;
  const user = gate.user;
  if (!user) return new Response("Not found", { status: 404 });
  if (user.role === "admin") {
    return Response.json({ ok: false, error: "The admin password is set in .env.local (LOCUS_ADMIN_PASSCODE), not here." }, { status: 400 });
  }
  let body: { current?: unknown; next?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  if (typeof body?.current !== "string" || typeof body?.next !== "string") {
    return Response.json({ ok: false, error: "Enter your current password and a new one." }, { status: 400 });
  }
  const db = getRecordsDb();
  try {
    const tv = await changeOwnPasscode(db, user.id, body.current, body.next);
    logActivity(db, activityFor(req, user, { kind: "passcode_changed" }));
    const token = await createSessionToken({ u: user.id, r: user.role, tv });
    const res = Response.json({ ok: true });
    res.headers.append("Set-Cookie", sessionCookie(token, sessionTtlMs()));
    return res;
  } catch (err) {
    if (err instanceof UserError) {
      logActivity(db, activityFor(req, user, { kind: "passcode_changed", status: "denied", message: err.message }));
      return Response.json({ ok: false, error: err.message }, { status: err.code === "wrong-passcode" ? 403 : 400 });
    }
    throw err;
  }
}
