import { SESSION_COOKIE } from "@/lib/auth";

/** Clears the session cookie. Reachable without a valid session on purpose, so a stale or expired cookie can always be cleared. */
export async function POST() {
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=0"].join("; ")
  );
  return res;
}
