import { execFile } from "node:child_process";
import type { Progress } from "./pipeline";

/**
 * Progress output and memory measurement for long library runs.
 */

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const n = (x: number) => x.toLocaleString("en-US");

/** Pages per second over the last `windowMs`; drops older samples from `recent` as it goes. */
export function rollingRate(recent: Array<[number, number]>, now: number, windowMs = 60_000): number {
  while (recent.length > 0 && recent[0][0] < now - windowMs) recent.shift();
  if (recent.length === 0) return 0;
  const pages = recent.reduce((sum, [, p]) => sum + p, 0);
  const span = Math.max(1000, Math.min(windowMs, now - recent[0][0]));
  return pages / (span / 1000);
}

export interface ProgressLine {
  text: string;
  pagesPerSec: number;
  etaSeconds: number | null;
}

export function progressLine(p: Progress, now: number, memory?: MemoryPeak): ProgressLine {
  const rate = rollingRate(p.recentPages, now);
  const finished = p.filesIndexed + p.filesUnchanged + p.filesRenamed + p.filesFailed;
  const remainingFiles = p.queued + p.running + p.deferred;
  const pagesPerFile = p.filesIndexed > 0 ? p.pagesDone / p.filesIndexed : null;
  const etaSeconds = rate > 0 && pagesPerFile !== null ? (remainingFiles * pagesPerFile) / rate : null;
  const parts = [
    p.state,
    `files ${n(finished)} done${remainingFiles > 0 ? `, ${n(remainingFiles)} to go` : ""} (${n(p.filesIndexed)} indexed, ${n(p.filesUnchanged)} unchanged, ${n(p.filesFailed)} failed)`,
    `pages ${n(p.pagesDone)}`,
    `${rate.toFixed(1)} pages/s`,
    `ETA ${etaSeconds === null ? (remainingFiles === 0 && !p.scanning ? "done" : "–") : formatDuration(etaSeconds)}`,
  ];
  if (p.scanning) parts.push(`scanning (${n(p.scanFilesSeen)} PDFs found, ${n(p.scanSkipped)} skipped)`);
  if (p.freeBytes !== null) parts.push(`free ${formatBytes(p.freeBytes)}`);
  if (memory) parts.push(`RAM ${formatBytes(memory.currentTotal)} (peak ${formatBytes(memory.peakTotal)})`);
  return { text: parts.join(" · "), pagesPerSec: rate, etaSeconds };
}

export interface MemoryPeak {
  /** This Node process's resident memory. */
  peakSelf: number;
  /** This process plus every child it's running (pdftotext, pdftoppm, tesseract...), summed at the same moment. */
  peakTotal: number;
  currentTotal: number;
  samples: number;
}

/** Resident memory of `pid`'s descendants, from one `ps` call. */
export function childrenRss(psOutput: string, pid: number): number {
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [p, pp, kb] = [Number(m[1]), Number(m[2]), Number(m[3])];
    rss.set(p, kb * 1024);
    children.set(pp, [...(children.get(pp) ?? []), p]);
  }
  let total = 0;
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const p = stack.pop()!;
    total += rss.get(p) ?? 0;
    stack.push(...(children.get(p) ?? []));
  }
  return total;
}

/** Samples memory every `intervalMs` until stopped; keeps the peaks. */
export class MemorySampler {
  readonly peak: MemoryPeak = { peakSelf: 0, peakTotal: 0, currentTotal: 0, samples: 0 };
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = 5000): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(): Promise<void> {
    const self = process.memoryUsage().rss;
    const kids = await new Promise<number>((resolve) => {
      execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? 0 : childrenRss(stdout, process.pid))
      );
    });
    this.peak.samples++;
    this.peak.currentTotal = self + kids;
    this.peak.peakSelf = Math.max(this.peak.peakSelf, self);
    this.peak.peakTotal = Math.max(this.peak.peakTotal, self + kids);
  }
}
