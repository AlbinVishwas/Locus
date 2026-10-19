import { retentionDays } from "@/lib/uploads/config";

/**
 * Display-only app config, read-only -- this never changes chat or upload
 * behavior, it's the one place the UI gets to see settings it otherwise
 * has no way to know:
 *  - model: the header pill ("<model> · running locally"), the same env
 *    var chat/route.ts's lmStudio() already uses.
 *  - retentionDays: null unless LOCUS_RETENTION_DAYS is set. Files don't
 *    expire by default, so the client gates the "this conversation's
 *    files expired" notice (see Chat.tsx) behind this being non-null --
 *    without it, that notice would never have anything real to report.
 */
export async function GET() {
  const model = process.env.LM_STUDIO_MODEL ?? "qwen/qwen3-4b";
  return Response.json(
    { model, retentionDays: retentionDays() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
