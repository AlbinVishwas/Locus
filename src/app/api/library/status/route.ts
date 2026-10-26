import { getLibraryDb, libraryErrorStatus } from "@/lib/library/db";
import { libraryCounts } from "@/lib/library/store";
import { readWorker } from "@/lib/library/sources/view";
import { ownedSources } from "@/lib/library/sources/owned";
import { requireSourcesAccess } from "@/lib/session";
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
  let ownerId: number | null = null; // set for an ordinary account: it is told only about its own folders
  if (usersEnabled()) {
    if (!req) return new Response("Not authenticated", { status: 401 });
    const gate = await requireSourcesAccess(req);
    if (!gate.ok) return gate.response;
    if (gate.user?.role !== "admin") ownerId = gate.user!.id;
  }
  const json = (s: LibraryStatus) => Response.json(s, { headers: { "Cache-Control": "no-store" } });
  const none = { documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 };
  if (conn.status === "disconnected") return json({ connected: false, ...none });
  if (conn.status === "empty") return json({ connected: true, ...none });
  try {
    if (ownerId !== null) {
      // Counts of their own folders only: the library's totals say too much about other people's.
      const mine = ownedSources(conn.db, ownerId);
      const ids = mine.map((m) => m.id);
      const marks = ids.map(() => "?").join(",");
      const one = (sql: string) => (ids.length === 0 ? 0 : Number(conn.db.prepare(sql).pluck().get(...ids) ?? 0));
      return json({
        connected: true,
        documents: one(`SELECT count(*) FROM documents WHERE status = 'ready' AND source_id IN (${marks})`),
        pagesIndexed: one(`SELECT coalesce(sum(pages_done), 0) FROM documents WHERE source_id IN (${marks})`),
        indexing: one(`SELECT count(*) FROM jobs WHERE state IN ('pending','running') AND source_id IN (${marks})`),
        failed: one(`SELECT count(*) FROM failures WHERE source_id IN (${marks})`),
        ...(mine.length > 0 ? { sources: mine.map((m) => ({ id: m.id, name: m.name, kind: m.kind })) } : {}),
      });
    }
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
