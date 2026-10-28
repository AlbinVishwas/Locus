import { errorResponse } from "@/lib/errors/catalog";
import { getLibraryDb } from "@/lib/library/db";
import { appLibraryConfig, RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { ownedSources } from "@/lib/library/sources/owned";
import { getRegistrySource } from "@/lib/library/sources/registry";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { connectorForSource, streamPdf } from "@/lib/server/originals";
import { activityFor, requireSourcesAccess } from "@/lib/session";
import { usersEnabled } from "@/lib/users/mode";

// better-sqlite3 and the connectors are Node-only.
export const runtime = "nodejs";

/**
 * GET /api/library/file?doc=<id>  --  the original PDF of a library hit, streamed from the storage server (or
 * library folder) after the same access check search uses: the administrator may open any document, an ordinary
 * account (LOCUS_USER_SOURCES) only documents of folders it owns. Open it at a page with #page=N on the link.
 */
export async function GET(req: Request) {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return errorResponse("LOCUS-NOTFOUND-001");
  let owned: Set<string> | null = null;
  let user = null;
  if (usersEnabled()) {
    const gate = await requireSourcesAccess(req);
    if (!gate.ok) return gate.response;
    user = gate.user!;
    if (user.role !== "admin") owned = new Set(ownedSources(conn.status === "ok" ? conn.db : null, user.id).map((s) => s.id));
  }
  if (conn.status !== "ok") return errorResponse("LOCUS-INDEX-002");

  const doc = Number(new URL(req.url).searchParams.get("doc"));
  if (!Number.isInteger(doc) || doc <= 0) return errorResponse("LOCUS-NOTFOUND-001");
  const row = conn.db.prepare("SELECT source_id AS sourceId, key, display_name AS displayName FROM documents WHERE id = ?").get(doc) as { sourceId: string; key: string; displayName: string } | undefined;
  // The same answer for a document that doesn't exist and one that isn't yours, so ids can't be probed.
  if (!row || (owned && !owned.has(row.sourceId))) return errorResponse("LOCUS-NOTFOUND-001");

  let connector;
  try {
    connector = withRegistry((registry, config) => {
      const entry = getRegistrySource(registry, row.sourceId);
      return entry ? connectorForSource(entry, appLibraryConfig() ?? config) : null;
    });
  } catch (err) {
    if (err instanceof RegistryUnavailable) return errorResponse("LOCUS-SERVER-001");
    throw err;
  }
  if (!connector) return errorResponse("LOCUS-NOTFOUND-001", "This kind of source can't be opened from here.");

  if (user && !req.headers.get("range")) {
    logActivity(getRecordsDb(), activityFor(req, user, { kind: "open_original", scope: `source:${row.sourceId}`, details: { docId: doc } }));
  }
  return streamPdf(req, connector, row.key, row.displayName);
}
