import { getLibraryDb, libraryErrorStatus } from "@/lib/library/db";
import { libraryCounts } from "@/lib/library/store";
import { readWorker } from "@/lib/library/sources/view";
import { requireAdmin } from "@/lib/session";
import { usersEnabled } from "@/lib/users/mode";
import type { LibraryStatus } from "@/lib/libraryClient";

export const runtime = "nodejs";

/**
 * The library status line: documents, pages indexed, still indexing,
 * failed, and whether the drive is connected. 404 unless the library is
 * enabled. Counts only -- never a path or a filename.
 */
export async function GET(req?: Request) {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return new Response("Not found", { status: 404 });
  if (usersEnabled()) {
    if (!req) return new Response("Not authenticated", { status: 401 });
    const gate = await requireAdmin(req);
    if (!gate.ok) return gate.response;
  }
  const json = (s: LibraryStatus) => Response.json(s, { headers: { "Cache-Control": "no-store" } });
  const none = { documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 };
  if (conn.status === "disconnected") return json({ connected: false, ...none });
  if (conn.status === "empty") return json({ connected: true, ...none });
  try {
    const c = libraryCounts(conn.db);
    // Named sources (for the scope dropdown) and the indexer's storage numbers appear only once there is
    // something to show, so a library with neither answers exactly as it always did.
    const sources = conn.db.prepare("SELECT id, name, kind FROM sources WHERE name IS NOT NULL ORDER BY ordinal").all() as Array<{ id: string; name: string; kind: string }>;
    const worker = readWorker(conn.db);
    return json({
      connected: true,
      documents: c.ready,
      pagesIndexed: c.pagesIndexed,
      indexing: c.jobsPending + c.jobsRunning,
      failed: c.failures,
      ...(sources.length > 0 ? { sources } : {}),
      ...(worker.usedBytes !== null
        ? { storage: { usedBytes: worker.usedBytes, capBytes: worker.capBytes, freeBytes: worker.freeBytes, minFreeBytes: worker.minFreeBytes, limit: worker.limit } }
        : {}),
    });
  } catch (err) {
    if (libraryErrorStatus(err) === "disconnected") return json({ connected: false, ...none });
    console.error("[/api/library/status] failed", { error: err instanceof Error ? err.message : err });
    return new Response("Library status failed. See the server log for details.", { status: 500 });
  }
}
