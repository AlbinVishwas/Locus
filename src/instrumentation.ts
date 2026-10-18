/**
 * Next.js calls register() once per server process, before anything else
 * runs. It's the one hook that fires exactly once regardless of how many
 * requests or route modules come after it, which makes it the right place
 * to start a process-lifetime background job -- the hourly retention
 * cleanup -- instead of trying to start it from inside a route handler and
 * guarding against every handler racing to start it twice.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { uploadsEnabled } = await import("@/lib/uploads/config");
  if (!uploadsEnabled()) return;

  const { startRetentionSchedule } = await import("@/lib/uploads/cleanup");
  startRetentionSchedule();
}
