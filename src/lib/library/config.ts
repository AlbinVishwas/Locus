import os from "node:os";
import path from "node:path";
import { envWithFallback } from "../env";
import { loadServerConfig, type ServerConfig } from "../server/config";

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
  let raw = (env.LOCUS_SEARCH_SCOPE ?? "session").trim().toLowerCase();
  if (raw === "all") raw = "library"; // "All sources" in the dropdown
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

/**
 * Where the library keeps its data when LOCUS_DATA_DIR isn't set: inside the
 * project, under /data, which git and Vercel already ignore (and which
 * next.config.ts keeps out of every build trace).
 */
export function defaultDataDir(): string {
  // turbopackIgnore: a runtime path; without the hint Next's file tracer
  // can't tell what it points at and traces the project (see indexDb.ts).
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/locus-data");
}

export interface LibraryConfig {
  /** Everything the library writes goes under here: the laptop's disk by default, or an external drive. */
  dataDir: string;
  /** True when LOCUS_DATA_DIR wasn't set and dataDir is the default inside the project. */
  dataDirIsDefault: boolean;
  /** Cap on everything the library writes (LOCUS_LIBRARY_MAX_GB, default 100). */
  maxBytes: number;
  /** Folders a folder source may be read from (LOCUS_ALLOWED_ROOTS, default /Volumes). */
  allowedRoots: string[];
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
  ocrPages: "auto" | "all" | "smart";
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
  /** Free space always left on the disk (LOCUS_MIN_FREE_GB, default 20), even under the cap. */
  minFreeBytes: number;
  rescanMinutes: number;
  watch: boolean;
  crossDevice: boolean;
  /** LOCUS_DATA_DIR on exFAT is refused unless this is set (see storage/volume.ts for why). */
  allowExfat: boolean;
  sample: number | null;
  sampleSeed: number;
  /** The company storage server (LOCUS_SERVER_*): type "none" when not connected. */
  server: ServerConfig;
  /** Set when LOCUS_SERVER_* is wrong: shown on the Server page instead of crashing the worker. */
  serverError: string | null;
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

function allowedRootsFrom(env: Env): string[] {
  const raw = env.LOCUS_ALLOWED_ROOTS;
  const roots = raw === undefined || raw.trim() === "" ? ["/Volumes"] : raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of roots) {
    if (!path.isAbsolute(r)) throw new Error(`LOCUS_ALLOWED_ROOTS entries must be absolute paths, got "${r}"`);
  }
  const resolved = roots.map((r) => path.resolve(r));
  if (resolved.some((r) => r === path.parse(r).root)) {
    throw new Error('LOCUS_ALLOWED_ROOTS can\'t include "/" itself: that would allow every folder on this Mac.');
  }
  return resolved;
}

/** LOCUS_MIN_FREE_GB, or its earlier name LIBRARY_MIN_FREE_GB (with a one-time deprecation warning). */
function minFreeGb(env: Env): number {
  const raw = env === process.env ? envWithFallback("LOCUS_MIN_FREE_GB", "LIBRARY_MIN_FREE_GB") : (env.LOCUS_MIN_FREE_GB ?? env.LIBRARY_MIN_FREE_GB);
  // 20 GB for the original always-on library machine; a laptop with a storage server connected keeps 5 GB free.
  if (raw === undefined || raw.trim() === "") return serverConnected(env) ? 5 : 20;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`LOCUS_MIN_FREE_GB must be zero or more, got "${raw}"`);
  return value;
}

function serverConnected(env: Env): boolean {
  const t = (env.LOCUS_SERVER_TYPE ?? "none").trim().toLowerCase();
  return t === "folder" || t === "s3";
}

export function loadLibraryConfig(env: Env = process.env): LibraryConfig {
  const explicitDataDir = optionalPath(env, "LOCUS_DATA_DIR");
  // "smart" (also catches broken words and lettering outside the text layer) is the default once a storage
  // server is connected; the library as it was keeps "auto" unless LIBRARY_OCR_PAGES says otherwise.
  const ocrPages = (env.LIBRARY_OCR_PAGES ?? (serverConnected(env) ? "smart" : "auto")).trim();
  if (ocrPages !== "auto" && ocrPages !== "all" && ocrPages !== "smart") {
    throw new Error(`LIBRARY_OCR_PAGES must be "auto", "all" or "smart", got "${ocrPages}"`);
  }
  let server: ServerConfig = { type: "none" };
  let serverError: string | null = null;
  try {
    server = loadServerConfig(env);
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  }
  const concurrency = Math.floor(positive(env, "LIBRARY_CONCURRENCY", Math.max(1, os.availableParallelism() - 2)));
  return {
    dataDir: explicitDataDir ?? defaultDataDir(),
    dataDirIsDefault: explicitDataDir === null,
    maxBytes: positive(env, "LOCUS_LIBRARY_MAX_GB", 100) * 1024 ** 3,
    allowedRoots: allowedRootsFrom(env),
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
    minFreeBytes: minFreeGb(env) * 1024 ** 3,
    rescanMinutes: positive(env, "LIBRARY_RESCAN_MINUTES", 60),
    watch: flag(env, "LIBRARY_WATCH"),
    crossDevice: flag(env, "LIBRARY_CROSS_DEVICE"),
    allowExfat: flag(env, "LOCUS_DATA_DIR_ALLOW_EXFAT"),
    sample: env.LIBRARY_SAMPLE?.trim() ? Math.floor(positive(env, "LIBRARY_SAMPLE", 1)) : null,
    sampleSeed: Math.floor(positive(env, "LIBRARY_SAMPLE_SEED", 20261023)),
    server,
    serverError,
  };
}

/** Every path the library writes to, all derived from LOCUS_DATA_DIR -- the one place they're decided. */
export interface LibraryPaths {
  dataDir: string;
  root: string;
  db: string;
  /** The sources registry (written by the app's admin APIs, read by the indexer worker). */
  sources: string;
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
    sources: path.join(root, "sources.db"),
    ocrCache: path.join(root, "ocr-cache.db"),
    tmp: path.join(root, "tmp"),
    logs: path.join(root, "logs"),
    inventory: path.join(root, "inventory"),
    lock: path.join(root, "indexer.lock"),
    marker: path.join(dataDir, ".locus-data-dir"),
  };
}
