import type { ActivityFilter, ActivityStatus } from "@/lib/records/activity";

const STATUSES: ActivityStatus[] = ["ok", "error", "denied", "refused"];

/** The filters shared by the list and the CSV export. null = a bad value. */
export function filterFromParams(p: URLSearchParams): ActivityFilter | null {
  const f: ActivityFilter = {};
  const user = p.get("user");
  if (user) f.username = user.slice(0, 64);
  const kinds = p.get("kind");
  if (kinds) f.kinds = kinds.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 30);
  const status = p.get("status");
  if (status) {
    const list = status.split(",").map((s) => s.trim());
    if (!list.every((s) => STATUSES.includes(s as ActivityStatus))) return null;
    f.status = list as ActivityStatus[];
  }
  for (const key of ["from", "to"] as const) {
    const v = p.get(key);
    if (v) {
      if (Number.isNaN(Date.parse(v))) return null;
      f[key] = new Date(v).toISOString();
    }
  }
  const text = p.get("q");
  if (text) f.text = text.slice(0, 200);
  if (p.get("issues") === "1") f.issuesOnly = true;
  return f;
}

