import type { ServerStatus } from "./server/status";
import { errorText } from "./httpError";

/** Browser-side calls to /api/server (the Server page and the banner). Types only from the server module, so no server code reaches the bundle. */
export type { ServerStatus };

export interface TestResult {
  ok: boolean;
  code?: string;
  message: string;
  checkedAt?: string;
}

export async function getServerStatus(): Promise<{ ok: true; data: ServerStatus } | { ok: false; message: string; status: number }> {
  const res = await fetch("/api/server", { cache: "no-store" });
  if (!res.ok) return { ok: false, status: res.status, message: await errorText(res) };
  return { ok: true, data: (await res.json()) as ServerStatus };
}

export async function testServer(): Promise<TestResult> {
  const res = await fetch("/api/server/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) return { ok: false, message: await errorText(res) };
  return (await res.json()) as TestResult;
}

export async function rescanServer(): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch("/api/server/rescan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return res.ok ? { ok: true } : { ok: false, message: await errorText(res) };
}
