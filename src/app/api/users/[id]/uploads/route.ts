import { getRecordsDb } from "@/lib/records/db";
import { listUploadRecords } from "@/lib/records/ownership";
import { getUser } from "@/lib/records/users";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

/** What one user has uploaded (names, sizes, pages, status) -- the admin's check against a search result. Never the documents' text. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const raw = (await ctx.params).id;
  const db = getRecordsDb();
  const user = /^\d{1,9}$/.test(raw) ? getUser(db, Number(raw)) : null;
  if (!user) return Response.json({ error: "No such user" }, { status: 404 });
  return Response.json({ username: user.username, uploads: listUploadRecords(db, user.id) }, { headers: { "Cache-Control": "no-store" } });
}
