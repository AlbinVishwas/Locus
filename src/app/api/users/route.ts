import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { createUserWithGeneratedPasscode, listUsers, UserError } from "@/lib/records/users";
import { activityFor, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

/** The admin's list of accounts, with what each has uploaded and searched. Never a passcode or hash. */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const users = listUsers(getRecordsDb()).map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    disabled: u.disabledAt !== null,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    sessions: u.sessions,
    uploads: u.uploads,
    uploadBytes: u.uploadBytes,
    searches30d: u.searches30d,
  }));
  return Response.json({ users }, { headers: noStore });
}

/** Creates an account with a generated passcode, shown once in this response and never again. */
export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  let body: { username?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const db = getRecordsDb();
  try {
    const { user, passcode } = await createUserWithGeneratedPasscode(db, body?.username);
    logActivity(db, activityFor(req, gate.user, { kind: "user_created", message: `created ${user.username}` }));
    return Response.json({ user: { id: user.id, username: user.username }, passcode }, { status: 201, headers: noStore });
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: err.code === "taken" ? 409 : 400 });
    throw err;
  }
}
