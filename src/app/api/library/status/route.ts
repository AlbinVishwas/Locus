import { getLibraryDb, libraryErrorStatus } from "@/lib/library/db";
import { libraryCounts } from "@/lib/library/store";
import type { LibraryStatus } from "@/lib/libraryClient";

export const runtime = "nodejs";

/**
 * The library status line: documents, pages indexed, still indexing,
 * failed, and whether the drive is connected. 404 unless the library is
 * enabled. Counts only -- never a path or a filename.
 */
export async function GET() {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return new Response("Not found", { status: 404 });
  const json = (s: LibraryStatus) => Response.json(s, { headers: { "Cache-Control": "no-store" } });
  const none = { documents: 0, pagesIndexed: 0, indexing: 0, failed: 0 };
  if (conn.status === "unconfigured") return json({ configured: false, connected: false, ...none });
  if (conn.status === "disconnected") return json({ configured: true, connected: false, ...none });
  if (conn.status === "empty") return json({ configured: true, connected: true, ...none });
  try {
    const c = libraryCounts(conn.db);
    return json({
      configured: true,
      connected: true,
      documents: c.ready,
      pagesIndexed: c.pagesIndexed,
      indexing: c.jobsPending + c.jobsRunning,
      failed: c.failures,
    });
  } catch (err) {
    if (libraryErrorStatus(err) === "disconnected") return json({ configured: true, connected: false, ...none });
    console.error("[/api/library/status] failed", { error: err instanceof Error ? err.message : err });
    return new Response("Library status failed. See the server log for details.", { status: 500 });
  }
}
