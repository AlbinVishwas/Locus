const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** 38.2 GB, 412 MB: for storage lines. */
export function formatBytes(n: number): string {
  if (n >= 100 * GB) return `${Math.round(n / GB)} GB`;
  if (n >= GB) return `${(n / GB).toFixed(1).replace(/\.0$/, "")} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.max(Math.round(n / 1024), 0)} KB`;
}

/** "12 min ago", "2 h ago", "1 day ago", or "Never". */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "Never";
  const s = Math.max(Math.round(ms / 1000), 0);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

export interface StorageNumbers {
  usedBytes: number | null;
  capBytes: number | null;
  freeBytes: number | null;
  minFreeBytes: number | null;
}

/** "Library uses 38.2 GB of 100 GB · 96 GB free (20 GB kept in reserve)". Falls back to the limits alone before the indexer has measured. */
export function storageLine(s: StorageNumbers, limits: { capBytes: number; minFreeBytes: number }): string {
  const cap = s.capBytes ?? limits.capBytes;
  const reserve = s.minFreeBytes ?? limits.minFreeBytes;
  if (s.usedBytes === null) return `Library limit ${formatBytes(cap)} · ${formatBytes(reserve)} always kept free`;
  const free = s.freeBytes === null ? "" : ` · ${formatBytes(s.freeBytes)} free`;
  return `Library uses ${formatBytes(s.usedBytes)} of ${formatBytes(cap)}${free} (${formatBytes(reserve)} kept in reserve)`;
}
