import type { TestResult } from "./library/sources/testSource";
import type { SourceView, WorkerView } from "./library/sources/view";

/** Browser-side calls to the admin Sources API (/api/sources/*). */

export type { SourceView, WorkerView, TestResult };

export interface SourcesResponse {
  sources: SourceView[];
  worker: WorkerView;
  connected: boolean;
  allowedRoots: string[];
  capBytes: number;
  minFreeBytes: number;
  /** GOOGLE_API_KEY is set on the server. */
  driveConfigured: boolean;
  /** LOCUS_SECRETS_KEY is set, so a database password can be saved. */
  secretsConfigured: boolean;
}

export interface BrowseResponse {
  path: string | null;
  parent: string | null;
  crumbs: Array<{ name: string; path: string }>;
  entries: Array<{ name: string; path: string; readable: boolean }>;
  truncated: boolean;
}

async function call<T>(url: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

export const getSources = () => call<SourcesResponse>("/api/sources", "GET");
export const testSourceForm = (form: object) => call<TestResult>("/api/sources/test", "POST", form);
export const addSource = (form: object) => call<{ id: string; name: string }>("/api/sources", "POST", form);
export const sourceAction = (id: string, action: "pause" | "resume" | "rescan" | "rename", extra: object = {}) =>
  call<{ ok: boolean }>(`/api/sources/${encodeURIComponent(id)}`, "PATCH", { action, ...extra });
export const removeSource = (id: string) => call<{ ok: boolean }>(`/api/sources/${encodeURIComponent(id)}`, "DELETE");
export const browseFolder = (path: string | null) =>
  call<BrowseResponse>(`/api/sources/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`, "GET");
