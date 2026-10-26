import { signUp } from "@/lib/users/signin";
import { usersEnabled } from "@/lib/users/mode";

export const runtime = "nodejs";

/**
 * Create an account (users mode). Needs the sign-up code by default, so only
 * people you've given it to can register; LOCUS_SIGNUP=open lets anyone,
 * =off closes it. Rate-limited per address and overall. Signs the new user in.
 */
export async function POST(req: Request) {
  if (!usersEnabled()) return new Response("Not found", { status: 404 });
  let body: { username?: unknown; passcode?: unknown; code?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  const outcome = await signUp(req, body ?? {});
  if (!outcome.ok) return Response.json({ ok: false, error: outcome.error }, { status: outcome.status });
  const res = Response.json({ ok: true, role: outcome.user.role });
  res.headers.append("Set-Cookie", outcome.cookie);
  return res;
}
