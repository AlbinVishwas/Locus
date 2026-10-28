import os from "node:os";
import path from "node:path";

/**
 * Indexer settings. Each can be overridden with an environment variable, the
 * same way the chat route reads LM_STUDIO_* — so nothing about a particular
 * machine is hard-coded.
 */
export interface IndexerConfig {
  tendersDir: string;
  indexPath: string;
  /** OCR cache, so re-indexing an unchanged page never re-runs tesseract. */
  ocrCachePath: string;
  /** Tesseract language(s), e.g. "eng" or "eng+hin". */
  ocrLang: string;
  /**
   * "all": OCR every page that isn't blank, keeping its text layer too.
   * "auto": OCR only pages the heuristics flag (no text layer, large images,
   * suspect text). See docs/tender-search-report.md for why "all" is the
   * default for the library: the measurement found real text the heuristics missed.
   * "smart": "auto" plus the two checks that closed that gap: text-layer words
   * broken into pieces, and lettering drawn on the page with no word in the layer
   * (see docs/faster-uploads.md). The default for uploads.
   */
  ocrPages: "all" | "auto" | "smart";
  /**
   * Run a page again in this language when the first reading (ocrLang) shows it holds
   * Devanagari (Hindi): "eng+hin" costs roughly 30-55% more per page, so only those pages
   * pay for it. Null: every page is read once, in ocrLang.
   */
  ocrLangFallback?: string | null;
  ocrDpi: number;
  concurrency: number;
  /** Priority (nice value) the OCR tools run at, so OCR on every core leaves the laptop responsive. 0 = normal. */
  ocrNice?: number;
  /** Per external-tool call; a page that exceeds it is recorded as failed. */
  pageTimeoutMs: number;
  /** Below this many non-space characters a text layer counts as missing. */
  minTextChars: number;
  /** Image area / page area at or above which a text page is also OCR'd. */
  mixedImageCoverage: number;
  /** Dark-pixel fraction (at 50 DPI) below which a page counts as blank. */
  blankMaxInk: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

function ocrPagesSetting(fallback: "all" | "smart"): "all" | "auto" | "smart" {
  const raw = process.env.OCR_PAGES ?? fallback;
  if (raw !== "all" && raw !== "auto" && raw !== "smart") {
    throw new Error(`OCR_PAGES must be "all", "auto" or "smart", got "${raw}"`);
  }
  return raw;
}

function nonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or a positive number, got "${raw}"`);
  return value;
}

/**
 * Bump when extraction logic changes in a way that should redo every
 * document, even unchanged files.
 */
export const EXTRACTOR_VERSION = 1;

/**
 * The settings a document was extracted with, as a string stored next to it.
 * If any of these change, the next run re-indexes the document — otherwise
 * switching, say, OCR_PAGES from auto to all would silently apply only to
 * new files.
 */
export function settingsKey(config: IndexerConfig): string {
  return JSON.stringify({
    v: EXTRACTOR_VERSION,
    lang: config.ocrLang,
    dpi: config.ocrDpi,
    pages: config.ocrPages,
    // Only when set, so settings made before it existed keep the key they were stored with.
    ...(config.ocrLangFallback ? { langFallback: config.ocrLangFallback } : {}),
    minText: config.minTextChars,
    mixed: config.mixedImageCoverage,
    blank: config.blankMaxInk,
  });
}

/**
 * What uploads run with. They differ from the library indexer in what suits a person waiting:
 * OCR only the pages that need it (OCR_PAGES=all restores every page), English first with Hindi
 * only where Devanagari shows up (setting OCR_LANG reads every page in that language instead),
 * every core (OCR_CONCURRENCY) at a lowered priority (OCR_NICE).
 */
export function loadUploadConfig(cwd = process.cwd()): IndexerConfig {
  const base = loadConfig(cwd, { uploads: true });
  return base;
}

export function loadConfig(cwd = process.cwd(), options: { uploads?: boolean } = {}): IndexerConfig {
  const uploads = options.uploads === true;
  const indexPath = path.resolve(cwd, process.env.SEARCH_INDEX_PATH ?? "data/index/search.db");
  return {
    tendersDir: path.resolve(cwd, process.env.TENDERS_DIR ?? "data/tenders"),
    indexPath,
    ocrCachePath: path.resolve(
      cwd,
      process.env.OCR_CACHE_PATH ?? path.join(path.dirname(indexPath), "ocr-cache.db")
    ),
    // Indian tender documents routinely carry Devanagari text (signature
    // lines, stamps) that eng-only OCR reads as garbage; eng+hin reads it
    // correctly and costs roughly 30-55% more time per page, only at
    // upload/index time (see docs/tender-search-report.md and
    // docs/locus-summary.md for the measurement this default is based on).
    // Uploads: English first, Hindi only on pages that show Devanagari, unless OCR_LANG pins one language.
    ocrLang: process.env.OCR_LANG ?? (uploads ? "eng" : "eng+hin"),
    ocrLangFallback: uploads && !process.env.OCR_LANG ? (process.env.OCR_LANG_FALLBACK ?? "eng+hin") || null : null,
    ocrPages: ocrPagesSetting(uploads ? "smart" : "all"),
    ocrDpi: num("OCR_DPI", 300),
    // The library worker leaves two cores for the OS and the dev server; uploads use every core
    // and rely on OCR_NICE to keep the machine responsive.
    concurrency: Math.floor(num("OCR_CONCURRENCY", Math.max(1, os.availableParallelism() - (uploads ? 0 : 2)))),
    ocrNice: Math.round(nonNegative("OCR_NICE", uploads ? 10 : 0)),
    pageTimeoutMs: num("PAGE_TIMEOUT_MS", 120_000),
    minTextChars: num("MIN_TEXT_CHARS", 30),
    mixedImageCoverage: num("MIXED_IMAGE_COVERAGE", 0.3),
    blankMaxInk: num("BLANK_MAX_INK", 0.00005),
  };
}
