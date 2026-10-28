import { ERRORS } from "../errors/catalog";
import { diskInfo, mbOrGb, reserveBytes } from "../server/disk";
import { uploadsDir } from "./config";

/**
 * The free-disk check for uploads: before writing, the disk that holds the uploads folder must keep LOCUS_MIN_FREE_GB
 * (default 5 GB) free after this upload. Refused cleanly, before anything is written.
 */
export type SpaceCheck = { ok: true } | { ok: false; detail: string };

export function checkUploadSpace(incomingBytes: number, dir: string = uploadsDir()): SpaceCheck {
  let free: number;
  try {
    free = diskInfo(dir).freeBytes;
  } catch {
    return { ok: true }; // can't tell: don't block uploads on a failed measurement
  }
  const reserve = reserveBytes();
  // The upload is stored, and its text index takes room too: ask for twice the file.
  const needed = incomingBytes * 2 + reserve;
  if (free >= needed) return { ok: true };
  return {
    ok: false,
    detail: `${ERRORS["LOCUS-DISK-003"].message} This needs about ${mbOrGb(incomingBytes * 2)} and the disk has ${mbOrGb(free)} free, with ${mbOrGb(reserve)} kept in reserve. ${ERRORS["LOCUS-DISK-003"].action}`,
  };
}
