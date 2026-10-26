import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { getUser, removeUser, resetPasscode, setDisabled, UserError } from "@/lib/records/users";
import { removeOwnedSources } from "@/lib/library/sources/registry";
import { RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { activityFor, requireAdmin } from "@/lib/session";
import { deleteConversationUploads } from "@/lib/uploads/pipeline";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/**
 * { action: "disable" | "enable" | "reset-passcode" }. Disabling or resetting
 * signs that person out everywhere at once (their token version moves). The
 * admin account itself can't be changed from here.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const id = parseId((await ctx.params).id);
  const db = getRecordsDb();
  const user = id === null ? null : getUser(db, id);
  if (!user || user.role !== "user") return Response.json({ error: "No such user" }, { status: 404 });
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  switch (body?.action) {
    case "disable":
    case "enable":
      setDisabled(db, user.id, body.action === "disable");
      logActivity(db, activityFor(req, gate.user, { kind: body.action === "disable" ? "user_disabled" : "user_enabled", message: user.username }));
      return Response.json({ ok: true }, { headers: noStore });
    case "reset-passcode": {
      const passcode = await resetPasscode(db, user.id);
      logActivity(db, activityFor(req, gate.user, { kind: "user_passcode_reset", message: user.username }));
      return Response.json({ ok: true, passcode }, { headers: noStore });
    }
    default:
      return new Response('`action` must be "disable", "enable" or "reset-passcode"', { status: 400 });
  }
}

/** Removes the account, its sessions and their uploaded files. Their activity history stays. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const id = parseId((await ctx.params).id);
  const db = getRecordsDb();
  const user = id === null ? null : getUser(db, id);
  if (!user || user.role !== "user") return Response.json({ error: "No such user" }, { status: 404 });
  try {
    const sessions = removeUser(db, user.id);
    for (const conversationId of sessions) await deleteConversationUploads(conversationId);
    // Their folders go with them (the indexer deletes the index entries; the original files are never touched).
    let folders = 0;
    try {
      folders = withRegistry((registry) => removeOwnedSources(registry, user.id));
    } catch (err) {
      if (!(err instanceof RegistryUnavailable)) throw err;
    }
    logActivity(db, activityFor(req, gate.user, { kind: "user_removed", message: user.username, details: { sessions: sessions.length, folders } }));
    return Response.json({ ok: true }, { headers: noStore });
  } catch (err) {
    if (err instanceof UserError) return Response.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
