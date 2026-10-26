import { getLibraryDb } from "@/lib/library/db";
import { cleanName } from "@/lib/library/sources/forms";
import { RegistryUnavailable, withRegistry } from "@/lib/library/sources/appRegistry";
import { getRegistrySource, RegistryError, renameRegistrySource, requestRescan, setSourceState } from "@/lib/library/sources/registry";
import { logActivity, type ActivityKind } from "@/lib/records/activity";
import { getRecordsDb } from "@/lib/records/db";
import { activityFor, requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

const ACTIONS: Record<string, ActivityKind> = { pause: "source_paused", resume: "source_resumed", rescan: "source_rescan", rename: "source_renamed" };

/** { action: "pause" | "resume" | "rescan" | "rename", name? }. The indexer notices within a couple of seconds. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  let body: { action?: unknown; name?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const action = typeof body?.action === "string" ? body.action : "";
  if (!(action in ACTIONS)) return new Response('`action` must be "pause", "resume", "rescan" or "rename"', { status: 400 });
  try {
    const name = withRegistry((registry) => {
      const source = getRegistrySource(registry, id);
      if (!source) throw new RegistryError("not-found", "No such source.");
      if (source.state === "removing") throw new RegistryError("invalid", "This source is being removed.");
      if (action === "pause") setSourceState(registry, id, "paused");
      else if (action === "resume") setSourceState(registry, id, "active");
      else if (action === "rescan") requestRescan(registry, id);
      else {
        const clean = cleanName(body.name);
        if (!clean.ok) throw new RegistryError("invalid", clean.message);
        renameRegistrySource(registry, id, clean.name);
        return clean.name;
      }
      return source.name;
    });
    logActivity(getRecordsDb(), activityFor(req, gate.user, { kind: ACTIONS[action], scope: `source:${name}` }));
    return Response.json({ ok: true }, { headers: noStore });
  } catch (err) {
    if (err instanceof RegistryError) return Response.json({ error: err.message }, { status: err.code === "not-found" ? 404 : err.code === "duplicate-name" ? 409 : 400 });
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}

/** Removes the source: its index entries go (the indexer does it, in the background); the original files are never touched. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (getLibraryDb().status === "disabled") return new Response("Not found", { status: 404 });
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  try {
    const name = withRegistry((registry) => {
      const source = getRegistrySource(registry, id);
      if (!source) throw new RegistryError("not-found", "No such source.");
      setSourceState(registry, id, "removing");
      return source.name;
    });
    logActivity(getRecordsDb(), activityFor(req, gate.user, { kind: "source_removed", scope: `source:${name}` }));
    return Response.json({ ok: true }, { headers: noStore });
  } catch (err) {
    if (err instanceof RegistryError) return Response.json({ error: err.message }, { status: err.code === "not-found" ? 404 : 400 });
    if (err instanceof RegistryUnavailable) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
}
