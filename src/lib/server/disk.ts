import fs from "node:fs";
import path from "node:path";

/**
 * Free space on a disk, for the checks that stop Locus before it fills one: the index estimate before a first
 * index, the pause while indexing, and the uploads. Works on macOS, Windows and Linux (fs.statfsSync), on the
 * disk that would hold `dir` even if `dir` doesn't exist yet.
 */

export function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

export interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
}

export function diskInfo(dir: string): DiskInfo {
  const s = fs.statfsSync(nearestExisting(dir));
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}

/** Free space Locus always leaves on the disk: LOCUS_MIN_FREE_GB (default 5 GB on a laptop). */
export function reserveBytes(env: Record<string, string | undefined> = process.env, fallbackGb = 5): number {
  const raw = (env.LOCUS_MIN_FREE_GB ?? env.LIBRARY_MIN_FREE_GB)?.trim();
  if (!raw) return fallbackGb * 1024 ** 3;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`LOCUS_MIN_FREE_GB must be zero or more, got "${raw}"`);
  return n * 1024 ** 3;
}

export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

export function mbOrGb(bytes: number): string {
  if (bytes >= 1024 ** 3) return gb(bytes);
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
