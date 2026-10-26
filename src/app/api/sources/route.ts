import { getLibraryDb } from "@/lib/library/db";
import { parseSourceInput } from "@/lib/library/sources/admin";
import { appLibraryConfig, RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { addRegistrySource, listOwnedSources, listRegistry, RegistryError } from "@/lib/library/sources/registry";
import { SecretError, secretsKeyFromEnv } from "@/lib/library/sources/secrets";
import { describeSources, readWorker, type WorkerView } from "@/lib/library/sources/view";
import { logActivity } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { listUsers } from "@/lib/records/users";
import { activityFor, requireSourcesAccess } from "@/lib/session";
import { userSourcesMax } from "@/lib/users/mode";

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

/** What an ordinary account may learn about the indexer: whether it's running and whether it's paused, not the library's numbers. */
function limitedWorker(w: WorkerView): WorkerView {
  return {
    running: w.running,
    heartbeatAt: null,
    state: null,
    limit: w.limit ? { kind: w.limit.kind, message: "Indexing is paused because the library's storage limit was reached." } : null,
    usedBytes: null,
    capBytes: null,
    freeBytes: null,
    minFreeBytes: null,
  };
}

/**
 * The Sources page's data. The administrator gets every source with its owner and the indexer's storage numbers;
 * an ordinary account (LOCUS_USER_SOURCES) gets only its own folders.
 */
export async function GET(req: Request) {
  const conn = getLibraryDb();
  if (conn.status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireSourcesAccess(req);
  if (!gate.ok) return gate.response;
  const user = gate.user!;
  const isAdmin = user.role === "admin";
  const library = conn.status === "ok" ? conn.db : null;
  try {
    const worker = readWorker(library);
    // Only the administrator is told whose folder is whose.
    const names = isAdmin ? new Map(listUsers(getRecordsDb()).map((u) => [u.id, u.username])) : undefined;
    const sources = withRegistry((registry) => describeSources(isAdmin ? listRegistry(registry) : listOwnedSources(registry, user.id), library, worker, names));
    const config = appLibraryConfig();
    return Response.json(
      {
        sources,
        scope: isAdmin ? "all" : "mine",
        worker: isAdmin ? worker : limitedWorker(worker),
        connected: conn.status !== "disconnected",
        allowedRoots: config.allowedRoots,
        capBytes: isAdmin ? config.maxBytes : 0,
        minFreeBytes: isAdmin ? config.minFreeBytes : 0,
        driveConfigured: isAdmin && Boolean(process.env.GOOGLE_API_KEY?.trim()),
        secretsConfigured: isAdmin && secretsConfigured(),
        maxSources: isAdmin ? null : userSourcesMax(),
      },
      { headers: noStore }
    );
  } catch (err) {
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}

/** Adds a source. Same checks as Test; the indexer picks it up within a couple of seconds. An ordinary account can add folders only, a limited number, and they are theirs alone. */
export async function POST(req: Request) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireSourcesAccess(req);
  if (!gate.ok) return gate.response;
  const user = gate.user!;
  const isAdmin = user.role === "admin";
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (!isAdmin && (body as { kind?: unknown } | null)?.kind !== "folder") {
    return Response.json({ error: "You can add folders only." }, { status: 403 });
  }
  try {
    const result = withRegistry((registry, config) => {
      if (!isAdmin && listOwnedSources(registry, user.id).length >= userSourcesMax()) {
        return { status: 409, body: { error: `You can have up to ${userSourcesMax()} folders. Remove one to add another.` } };
      }
      const parsed = parseSourceInput(body, config);
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
      const source = addRegistrySource(registry, {
        kind: parsed.kind,
        name: parsed.name,
        config: parsed.config,
        ...(parsed.secret !== undefined ? { secret: parsed.secret } : {}),
        createdBy: user.username,
        ownerId: isAdmin ? null : user.id,
      });
      return { status: 201, body: { id: source.id, name: source.name }, kind: parsed.kind, name: source.name };
    });
    if (result.status === 201) {
      logActivity(getRecordsDb(), activityFor(req, user, { kind: "source_added", scope: `source:${result.name}`, message: `${result.kind} source added` }));
    }
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (err) {
    if (err instanceof RegistryError) return Response.json({ error: err.message }, { status: err.code === "duplicate-name" ? 409 : 400 });
    if (err instanceof SecretError) return Response.json({ error: `Passwords can't be saved: ${err.message}` }, { status: 400 });
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
