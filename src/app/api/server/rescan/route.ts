import { errorResponse } from "@/lib/errors/catalog";
import { RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { getRegistrySource, requestRescan } from "@/lib/library/sources/registry";
import { SERVER_SOURCE_ID } from "@/lib/server/status";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

/** "Rescan now": asks the indexer to compare the server with the index straight away (it also does this every LOCUS_SYNC_INTERVAL_MIN minutes). */
export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  try {
    const found = withRegistry((registry) => {
      if (!getRegistrySource(registry, SERVER_SOURCE_ID)) return false;
      requestRescan(registry, SERVER_SOURCE_ID);
      return true;
    });
    if (!found) return errorResponse("LOCUS-SERVER-003", "No storage server is set up yet, or the indexer hasn't started once since it was added.");
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof RegistryUnavailable) return errorResponse("LOCUS-INDEX-002");
    throw err;
  }
}
