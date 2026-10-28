import { errorResponse } from "@/lib/errors/catalog";
import { logError, redact } from "@/lib/errors/redact";
import { appLibraryConfig } from "@/lib/library/sources/appRegistry";
import { createConnector } from "@/lib/server/connector";
import { ConnectorError } from "@/lib/server/types";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

/** "Test connection": a read-only look at the storage server with the settings from .env.local. The answer carries a message and a catalog code, never the settings' secrets. */
export async function POST(req: Request) {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const config = appLibraryConfig();
  if (config.serverError) return errorResponse("LOCUS-SERVER-003", config.serverError);
  if (config.server.type === "none") return errorResponse("LOCUS-SERVER-003", "No storage server is set up (LOCUS_SERVER_TYPE is none).");
  const connector = createConnector(config.server);
  try {
    const result = await connector.test(AbortSignal.timeout(20_000));
    return Response.json({ ...result, message: redact(result.message), checkedAt: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logError("server-test", err);
    return errorResponse(err instanceof ConnectorError ? err.code : "LOCUS-SERVER-001");
  } finally {
    await connector.close().catch(() => {});
  }
}
