import { browseFolders } from "@/lib/library/allowedRoots";
import { getLibraryDb } from "@/lib/library/db";
import { appLibraryConfig } from "@/lib/library/sources/appRegistry";
import { requireSourcesAccess } from "@/lib/session";

export const runtime = "nodejs";

/** One level of the folder browser: only folders, only inside the allowed roots. ?path= (absent = the roots themselves). */
export async function GET(req: Request) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireSourcesAccess(req);
  if (!gate.ok) return gate.response;
  const config = appLibraryConfig();
  const requested = new URL(req.url).searchParams.get("path");
  const out = browseFolders(requested, { roots: config.allowedRoots, dataDir: config.dataDir });
  if (!out.ok) return Response.json({ error: out.message }, { status: 400 });
  return Response.json(out, { headers: { "Cache-Control": "no-store" } });
}
