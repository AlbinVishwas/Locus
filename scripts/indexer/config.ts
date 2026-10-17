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
   * default: the measurement found real text the heuristics missed.
   */
  ocrPages: "all" | "auto";
  ocrDpi: number;
  concurrency: number;
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

function ocrPagesSetting(): "all" | "auto" {
  const raw = process.env.OCR_PAGES ?? "all";
  if (raw !== "all" && raw !== "auto") {
    throw new Error(`OCR_PAGES must be "all" or "auto", got "${raw}"`);
  }
  return raw;
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
    minText: config.minTextChars,
    mixed: config.mixedImageCoverage,
    blank: config.blankMaxInk,
  });
}

export function loadConfig(cwd = process.cwd()): IndexerConfig {
  const indexPath = path.resolve(cwd, process.env.SEARCH_INDEX_PATH ?? "data/index/search.db");
  return {
    tendersDir: path.resolve(cwd, process.env.TENDERS_DIR ?? "data/tenders"),
    indexPath,
    ocrCachePath: path.resolve(
      cwd,
      process.env.OCR_CACHE_PATH ?? path.join(path.dirname(indexPath), "ocr-cache.db")
    ),
    ocrLang: process.env.OCR_LANG ?? "eng",
    ocrPages: ocrPagesSetting(),
    ocrDpi: num("OCR_DPI", 300),
    // Leave two cores for the OS and the dev server.
    concurrency: Math.floor(num("OCR_CONCURRENCY", Math.max(1, os.availableParallelism() - 2))),
    pageTimeoutMs: num("PAGE_TIMEOUT_MS", 120_000),
    minTextChars: num("MIN_TEXT_CHARS", 30),
    mixedImageCoverage: num("MIXED_IMAGE_COVERAGE", 0.3),
    blankMaxInk: num("BLANK_MAX_INK", 0.00005),
  };
}
