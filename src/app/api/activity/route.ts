import { queryActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { requireAdmin } from "@/lib/session";
import { filterFromParams } from "./filter";

export const runtime = "nodejs";

/** The activity log, newest first, with keyset paging: ?before=<id> for the next page. */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const params = new URL(req.url).searchParams;
  const filter = filterFromParams(params);
  if (!filter) return new Response("Bad filter", { status: 400 });
  const limit = Number(params.get("limit") ?? 50);
  const beforeRaw = params.get("before");
  const before = beforeRaw === null ? undefined : Number(beforeRaw);
  if (!Number.isInteger(limit) || (before !== undefined && !Number.isSafeInteger(before))) return new Response("Bad paging", { status: 400 });
  return Response.json(queryActivity(getRecordsDb(), filter, { limit, before }), { headers: { "Cache-Control": "no-store" } });
}
