import { getLibraryDb } from "@/lib/library/db";
import { parseSourceInput } from "@/lib/library/sources/admin";
import { appLibraryConfig, RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { addRegistrySource, listRegistry, RegistryError } from "@/lib/library/sources/registry";
import { SecretError, secretsKeyFromEnv } from "@/lib/library/sources/secrets";
import { describeSources, readWorker } from "@/lib/library/sources/view";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { activityFor, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

function secretsConfigured(): boolean {
  try {
    secretsKeyFromEnv();
    return true;
  } catch {
    return false;
  }
}

/** The Sources page's data: every source with its status, and the indexer's own state and storage numbers. */
export async function GET(req: Request) {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const library = conn.status === "ok" ? conn.db : null;
  try {
    const worker = readWorker(library);
    const sources = withRegistry((registry) => describeSources(listRegistry(registry), library, worker));
    const config = appLibraryConfig();
    return Response.json(
      { sources, worker, connected: conn.status !== "disconnected", allowedRoots: config.allowedRoots, capBytes: config.maxBytes, minFreeBytes: config.minFreeBytes, driveConfigured: Boolean(process.env.GOOGLE_API_KEY?.trim()), secretsConfigured: secretsConfigured() },
      { headers: noStore }
    );
  } catch (err) {
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}

/** Adds a source. Same checks as Test; the indexer picks it up within a couple of seconds. */
export async function POST(req: Request) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  try {
    const result = withRegistry((registry, config) => {
      const parsed = parseSourceInput(body, config);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      const source = addRegistrySource(registry, {
        kind: parsed.kind,
        name: parsed.name,
        config: parsed.config,
        ...(parsed.secret !== undefined ? { secret: parsed.secret } : {}),
        createdBy: gate.user?.username ?? null,
      });
      return { status: 201, body: { id: source.id, name: source.name }, kind: parsed.kind, name: source.name };
    });
    if (result.status === 201) {
      logActivity(getRecordsDb(), activityFor(req, gate.user, { kind: "source_added", scope: `source:${result.name}`, message: `${result.kind} source added` }));
    }
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (err) {
    if (err instanceof RegistryError) return Response.json({ error: err.message }, { status: err.code === "duplicate-name" ? 409 : 400 });
    if (err instanceof SecretError) return Response.json({ error: `Passwords can't be saved: ${err.message}` }, { status: 400 });
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
