/**
 * The two limits on what the library may use on this Mac's disk:
 *
 *   cap      LOCUS_LIBRARY_MAX_GB (100): everything the library writes --
 *            index, OCR cache, job state, logs, temp files, registry.
 *   reserve  LOCUS_MIN_FREE_GB (20): free space on the disk that is always
 *            left alone, even under the cap, so the laptop never fills up.
 *
 * Pure decision logic; the numbers come from usage.ts and statfs. When
 * either limit is hit the library pauses (resumable), says so with these
 * messages and the current usage, and never deletes anything to make room.
 */

export interface LimitInputs {
  usedBytes: number;
  capBytes: number;
  freeBytes: number;
  minFreeBytes: number;
  /** Indexing stops this far below the cap, so a chunk written just before the check can't push past it. */
  marginBytes: number;
}

export type LimitKind = "cap" | "reserve";

export type LimitState =
  | ({ ok: true } & Numbers)
  | ({ ok: false; kind: LimitKind; message: string } & Numbers);

interface Numbers {
  usedBytes: number;
  capBytes: number;
  freeBytes: number;
  minFreeBytes: number;
}

const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GB).toFixed(1);

/** Default margin: 256 MB, but never more than 2% of a (small) cap. */
export function defaultMarginBytes(capBytes: number): number {
  return Math.min(256 * 1024 * 1024, Math.floor(capBytes * 0.02));
}

export function evaluateLimits(i: LimitInputs): LimitState {
  const numbers: Numbers = { usedBytes: i.usedBytes, capBytes: i.capBytes, freeBytes: i.freeBytes, minFreeBytes: i.minFreeBytes };
  if (i.usedBytes >= i.capBytes - i.marginBytes) {
    return {
      ok: false,
      kind: "cap",
      ...numbers,
      message:
        `Paused: storage limit. The library uses ${gb(i.usedBytes)} GB of its ${gb(i.capBytes)} GB limit. ` +
        `Remove a source, or raise LOCUS_LIBRARY_MAX_GB. Nothing has been deleted.`,
    };
  }
  if (i.freeBytes < i.minFreeBytes) {
    return {
      ok: false,
      kind: "reserve",
      ...numbers,
      message:
        `Paused: low disk space. ${gb(i.freeBytes)} GB free; Locus keeps ${gb(i.minFreeBytes)} GB in reserve. ` +
        `Free some space on this Mac; indexing resumes on its own.`,
    };
  }
  return { ok: true, ...numbers };
}

/** The status word the Sources page and terminal show for a limit pause. */
export function limitStateLabel(kind: LimitKind): "paused: storage limit" | "paused: low disk space" {
  return kind === "cap" ? "paused: storage limit" : "paused: low disk space";
}
