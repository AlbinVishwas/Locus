import fs from "node:fs";
import path from "node:path";
import { withCode } from "../errors/catalog";
import { mbOrGb } from "./disk";
import type { StorageConnector } from "./types";

/**
 * "Will the index fit?" before a first index starts. The index for a PDF is a multiple of the PDF's size that
 * depends on how much text it holds, so the estimate is the server's total PDF bytes times a ratio. The default
 * ratio is the largest one measured on the generated benchmark set (text-heavy PDFs make the biggest index; see
 * docs/server-benchmark.md), times a safety factor; once part of the index exists, the ratio observed on it
 * replaces the default (observedRatio), so the estimate sharpens as indexing runs.
 */

/**
 * Index bytes per PDF byte. What the index really costs is per PAGE of text, about 18-19 KB a page, measured on the
 * generated benchmark set with `npm run bench:server` (docs/server-benchmark.md; 19.7 KB a page on the earlier
 * 100k-page synthetic test too). A PDF's size per page varies, so the ratio assumes a dense 30 KB per page:
 * 18.6 / 30 = 0.62, rounded up. Scanned pages cost twice the index (two readings) but their PDFs are several
 * times larger per page, so they come out lower. Once 20 files are indexed the ratio actually seen replaces this.
 */
export const DEFAULT_INDEX_RATIO = 0.65;
/** Extra room beyond the estimate: the temp file of the largest in-flight PDFs, SQLite growth steps, the OCR cache. */
export const SAFETY_FACTOR = 1.25;

export interface SpacePlan {
  files: number;
  pdfBytes: number;
  ratio: number;
  /** What the whole index is expected to take. */
  estimateBytes: number;
  /** Of that, what is still to be written (the estimate minus what the index already uses). */
  remainingBytes: number;
  freeBytes: number;
  reserveBytes: number;
  /** Free space minus the reserve. */
  usableBytes: number;
  fits: boolean;
  shortByBytes: number;
}

export function planSpace(i: { files: number; pdfBytes: number; ratio?: number; freeBytes: number; reserveBytes: number; indexBytes?: number }): SpacePlan {
  const ratio = i.ratio ?? DEFAULT_INDEX_RATIO;
  const estimateBytes = Math.ceil(i.pdfBytes * ratio * SAFETY_FACTOR);
  const remainingBytes = Math.max(0, estimateBytes - (i.indexBytes ?? 0));
  const usableBytes = i.freeBytes - i.reserveBytes;
  const fits = remainingBytes <= usableBytes;
  return { files: i.files, pdfBytes: i.pdfBytes, ratio, estimateBytes, remainingBytes, freeBytes: i.freeBytes, reserveBytes: i.reserveBytes, usableBytes, fits, shortByBytes: fits ? 0 : remainingBytes - Math.max(0, usableBytes) };
}

/** The ratio seen so far on a partly built index: index bytes per PDF byte of the files already indexed. Null until there's enough to judge. */
export function observedRatio(indexBytes: number, indexedPdfBytes: number, indexedFiles: number): number | null {
  if (indexedFiles < 20 || indexedPdfBytes < 5 * 1024 ** 2 || indexBytes <= 0) return null;
  return indexBytes / indexedPdfBytes;
}

/** The message people see when it won't fit: how much it needs, how much is free, what to do. */
export function spaceMessage(p: SpacePlan, dataDir: string): string {
  return withCode(
    "LOCUS-DISK-001",
    `The index for ${p.files.toLocaleString("en-US")} PDFs (${mbOrGb(p.pdfBytes)}) needs about ${mbOrGb(p.estimateBytes)}, but only ${mbOrGb(Math.max(0, p.usableBytes))} is free after keeping ${mbOrGb(p.reserveBytes)} in reserve (${mbOrGb(p.freeBytes)} free on the disk holding ${dataDir}). ` +
      `Free up about ${mbOrGb(p.shortByBytes)}, or set LOCUS_DATA_DIR to a folder on a disk with more room, or index fewer folders (LOCUS_SERVER_PATH / LOCUS_SERVER_S3_PREFIX).`
  );
}

/** Sizes only: a listing pass that counts the server's PDFs and their bytes. */
export async function measureServer(connector: StorageConnector, signal: AbortSignal, maxFileBytes: number): Promise<{ files: number; pdfBytes: number }> {
  let files = 0;
  let pdfBytes = 0;
  for await (const f of connector.list(signal)) {
    if (!/\.pdf$/i.test(f.path) || f.size > maxFileBytes) continue;
    files++;
    pdfBytes += f.size;
  }
  return { files, pdfBytes };
}

export interface PreflightRecord {
  fingerprint: string;
  at: string;
  files: number;
  pdfBytes: number;
  estimateBytes: number;
  ok: boolean;
}

export function readPreflight(file: string): PreflightRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PreflightRecord;
  } catch {
    return null;
  }
}

export function writePreflight(file: string, rec: PreflightRecord): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  } catch {
    // A note for the Server page; never fail a scan over it.
  }
}
