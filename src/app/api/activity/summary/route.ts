import { summarizeIssues } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

/** Counts of what went wrong in the last 24 hours (or ?hours=N, up to 30 days): the strip at the top of the Activity page. */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const hours = Math.min(Math.max(Number(new URL(req.url).searchParams.get("hours") ?? 24) || 24, 1), 720);
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  return Response.json(summarizeIssues(getRecordsDb(), since), { headers: { "Cache-Control": "no-store" } });
}
