import os from "node:os";
import path from "node:path";

type Env = Record<string, string | undefined>;

/**
 * Document-library settings. All of them are inert unless set: with none of
 * them in the environment, nothing in the library feature runs or touches
 * the disk, and Locus behaves exactly as it did before the feature existed.
 * See docs/library.md for what each one means in practice.
 */

/** The master switch for the library in the app (routes, UI). Off unless LOCUS_LIBRARY_ENABLED=true. */
export function isLibraryEnabled(env: Env = process.env): boolean {
  const raw = env.LOCUS_LIBRARY_ENABLED?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

export type SearchScope = "session" | "library" | "both";

/** Which documents a search covers by default. Only meaningful with the library enabled. */
export function searchScope(env: Env = process.env): SearchScope {
  const raw = (env.LOCUS_SEARCH_SCOPE ?? "session").trim().toLowerCase();
  if (raw !== "session" && raw !== "library" && raw !== "both") {
    throw new Error(`LOCUS_SEARCH_SCOPE must be "session", "library" or "both", got "${raw}"`);
  }
  return raw;
}

/**
 * Skipped by default: system folders macOS and Windows put on drives,
 * hidden files, Office lock files, and files a download or copy hasn't
 * finished writing. Matched against the folder-relative path; a matching
 * directory is never descended into.
 */
export const DEFAULT_EXCLUDES = [
  "**/.Trashes",
  "**/.Spotlight-V100",
  "**/.fseventsd",
  "**/.DocumentRevisions-V100",
  "**/.TemporaryItems",
  "**/$RECYCLE.BIN",
  "**/System Volume Information",
  "**/.*",
  "**/~$*",
  "**/*.tmp",
  "**/*.part",
  "**/*.crdownload",
  "**/*.download",
  "**/*.zip",
];

export const DEFAULT_INCLUDES = ["**/*.pdf"];

export interface LibraryConfig {
  /** Everything the library writes goes under here. Must be an existing folder on an external drive. */
  dataDir: string | null;
  /** Folder source root (read in place, never written). */
  libraryDir: string | null;
  dbUrl: string | null;
  dbQuery: string | null;
  dbBatchSize: number;
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  /** Printed page labels need the whole file in memory (pdf.js); only read them up to this size. */
  labelsMaxBytes: number;
  ocrPages: "auto" | "all";
  ocrLang: string;
  ocrDpi: number;
  /** External tool processes (pdftotext, pdftoppm, tesseract...) at once. */
  concurrency: number;
  /** Files being worked on at once. */
  filesInFlight: number;
  /** Pages per pdftotext / pdfimages call. 1 is the most memory-safe; a few more is faster. */
  pageWindow: number;
  pageTimeoutMs: number;
  fileTimeoutMs: number;
  settleSeconds: number;
  minFreeBytes: number;
  rescanMinutes: number;
  watch: boolean;
  crossDevice: boolean;
  /** LOCUS_DATA_DIR on exFAT is refused unless this is set (see storage/volume.ts for why). */
  allowExfat: boolean;
  sample: number | null;
  sampleSeed: number;
}

function positive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function flag(env: Env, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

function list(env: Env, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function optionalPath(env: Env, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? path.resolve(raw) : null;
}

export function loadLibraryConfig(env: Env = process.env): LibraryConfig {
  const ocrPages = (env.LIBRARY_OCR_PAGES ?? "auto").trim();
  if (ocrPages !== "auto" && ocrPages !== "all") {
    throw new Error(`LIBRARY_OCR_PAGES must be "auto" or "all", got "${ocrPages}"`);
  }
  const concurrency = Math.floor(positive(env, "LIBRARY_CONCURRENCY", Math.max(1, os.availableParallelism() - 2)));
  return {
    dataDir: optionalPath(env, "LOCUS_DATA_DIR"),
    libraryDir: optionalPath(env, "LOCUS_LIBRARY_DIR"),
    dbUrl: env.LIBRARY_DB_URL?.trim() || null,
    dbQuery: env.LIBRARY_DB_QUERY?.trim() || null,
    dbBatchSize: Math.floor(positive(env, "LIBRARY_DB_BATCH_SIZE", 500)),
    include: list(env, "LIBRARY_INCLUDE", DEFAULT_INCLUDES),
    exclude: list(env, "LIBRARY_EXCLUDE", DEFAULT_EXCLUDES),
    maxFileBytes: positive(env, "LIBRARY_MAX_FILE_BYTES", 500 * 1024 * 1024),
    labelsMaxBytes: positive(env, "LIBRARY_LABELS_MAX_BYTES", 20 * 1024 * 1024),
    ocrPages,
    ocrLang: env.LIBRARY_OCR_LANG?.trim() || "eng+hin",
    ocrDpi: Math.floor(positive(env, "LIBRARY_OCR_DPI", 300)),
    concurrency,
    filesInFlight: Math.floor(positive(env, "LIBRARY_FILES_IN_FLIGHT", 4)),
    pageWindow: Math.floor(positive(env, "LIBRARY_PAGE_WINDOW", 20)),
    pageTimeoutMs: positive(env, "PAGE_TIMEOUT_MS", 120_000),
    fileTimeoutMs: positive(env, "LIBRARY_FILE_TIMEOUT_MS", 30 * 60 * 1000),
    settleSeconds: positive(env, "LIBRARY_SETTLE_SECONDS", 120),
    minFreeBytes: positive(env, "LIBRARY_MIN_FREE_GB", 20) * 1024 ** 3,
    rescanMinutes: positive(env, "LIBRARY_RESCAN_MINUTES", 60),
    watch: flag(env, "LIBRARY_WATCH"),
    crossDevice: flag(env, "LIBRARY_CROSS_DEVICE"),
    allowExfat: flag(env, "LOCUS_DATA_DIR_ALLOW_EXFAT"),
    sample: env.LIBRARY_SAMPLE?.trim() ? Math.floor(positive(env, "LIBRARY_SAMPLE", 1)) : null,
    sampleSeed: Math.floor(positive(env, "LIBRARY_SAMPLE_SEED", 20261023)),
  };
}

/** Every path the library writes to, all derived from LOCUS_DATA_DIR -- the one place they're decided. */
export interface LibraryPaths {
  dataDir: string;
  root: string;
  db: string;
  ocrCache: string;
  tmp: string;
  logs: string;
  inventory: string;
  lock: string;
  marker: string;
}

export function libraryPaths(dataDir: string): LibraryPaths {
  const root = path.join(dataDir, "library");
  return {
    dataDir,
    root,
    db: path.join(root, "library.db"),
    ocrCache: path.join(root, "ocr-cache.db"),
    tmp: path.join(root, "tmp"),
    logs: path.join(root, "logs"),
    inventory: path.join(root, "inventory"),
    lock: path.join(root, "indexer.lock"),
    marker: path.join(dataDir, ".locus-data-dir"),
  };
}
