import { getLibraryDb } from "@/lib/library/db";
import { appLibraryConfig } from "@/lib/library/sources/appRegistry";
import { testSource } from "@/lib/library/sources/testSource";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { activityFor, requireSourcesAccess } from "@/lib/session";

export const runtime = "nodejs";

/** Tries a source's settings (folder / database / Drive link) without saving anything: can Locus reach it, and what is in it. */
export async function POST(req: Request) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireSourcesAccess(req);
  if (!gate.ok) return gate.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (gate.user?.role !== "admin" && (body as { kind?: unknown } | null)?.kind !== "folder") {
    return Response.json({ error: "You can add folders only." }, { status: 403 });
  }
  const result = await testSource(body, appLibraryConfig());
  logActivity(getRecordsDb(), activityFor(req, gate.user, { kind: "source_tested", status: result.ok ? "ok" : "error", message: result.ok ? undefined : result.message.slice(0, 200), details: { kind: (body as { kind?: unknown })?.kind } }));
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
