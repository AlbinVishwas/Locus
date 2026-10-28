import { errorResponse } from "@/lib/errors/catalog";
import { getLibraryDb } from "@/lib/library/db";
import { appLibraryConfig } from "@/lib/library/sources/appRegistry";
import { buildServerStatus } from "@/lib/server/status";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

/** The Server page's data: connection settings (no secrets), sync and indexing progress, disk numbers, files that couldn't be read. Admin only. */
export async function GET(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const conn = getLibraryDb();
  if (conn.status === "disabled") return errorResponse("LOCUS-NOTFOUND-001", "The library is switched off (LOCUS_LIBRARY_ENABLED).");
  const status = buildServerStatus(conn.status === "ok" ? conn.db : null, appLibraryConfig());
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}
