import { activityToCsv, queryActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { requireAdmin } from "@/lib/session";
import { filterFromParams } from "../filter";

export const runtime = "nodejs";

const MAX_ROWS = 50_000;

/** The same filters as the list, as a CSV download (formula cells are defused). */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const filter = filterFromParams(new URL(req.url).searchParams);
  if (!filter) return new Response("Bad filter", { status: 400 });
  const db = getRecordsDb();
  const rows = [];
  let before: number | undefined;
  while (rows.length < MAX_ROWS) {
    const page = queryActivity(db, filter, { limit: 500, before });
    rows.push(...page.rows);
    if (page.nextBefore === null) break;
    before = page.nextBefore;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(activityToCsv(rows), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="locus-activity-${stamp}.csv"`, "Cache-Control": "no-store" },
  });
}
