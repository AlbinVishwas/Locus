import { SESSION_COOKIE } from "@/lib/auth";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { activityFor, currentUser } from "@/lib/session";
import { usersEnabled } from "@/lib/users/mode";

/** Clears the session cookie. Reachable without a valid session on purpose, so a stale or expired cookie can always be cleared. */
export async function POST(req?: Request) {
  if (req && usersEnabled()) {
    // Best effort: note who signed out. A stale cookie just means nobody to name.
    try {
      const user = await currentUser(req);
      if (user) logActivity(getRecordsDb(), activityFor(req, user, { kind: "logout" }));
    } catch {
      // signing out must always work
    }
  }
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ")
  );
  return res;
}
