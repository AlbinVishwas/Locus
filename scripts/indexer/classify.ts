/**
 * Decisions about a page, as pure functions over measurements — no files, no
 * processes — so each rule can be tested directly.
 */

export interface Pgm {
  width: number;
  height: number;
  maxValue: number;
  pixels: Uint8Array;
}

/** Parses the binary greyscale image format pdftoppm -gray writes (P5). */
export function parsePgm(buf: Buffer): Pgm {
  // Header: "P5", width, height, max value, each separated by whitespace,
  // then exactly one whitespace byte before the pixel data.
  const header = buf.toString("latin1", 0, Math.min(buf.length, 128));
  const m = header.match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/);
  if (!m) throw new Error("not a binary PGM image");
  const width = Number(m[1]);
  const height = Number(m[2]);
  const maxValue = Number(m[3]);
  if (maxValue > 255) throw new Error("16-bit PGM not supported");
  const start = m[0].length;
  const pixels = new Uint8Array(buf.buffer, buf.byteOffset + start, width * height);
  if (pixels.length !== width * height) throw new Error("truncated PGM image");
  return { width, height, maxValue, pixels };
}

/** Fraction of pixels darker than light grey: "how much ink is on the page". */
export function inkFraction(pgm: Pgm, darkerThan = 200): number {
  let dark = 0;
  for (const value of pgm.pixels) if (value < darkerThan) dark++;
  return pgm.pixels.length === 0 ? 0 : dark / pgm.pixels.length;
}

export function nonSpaceLength(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * A text layer that is present but probably not real text — e.g. a font
 * with a broken character map, which extracts as symbol soup. Fill-in lines
 * (____, ....), dashes and private-use bullet glyphs are ignored first,
 * because tender forms are full of them and they are not a sign of trouble.
 */
export function isSuspectTextLayer(text: string): boolean {
  const meaningful = text.replace(/[\s_.\-\u2013\u2014\u2026\u00B7\u2022|\uE000-\uF8FF\u2500-\u257F]/g, "");
  if (meaningful.length < 30) return false;
  const lettersAndDigits = (meaningful.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return lettersAndDigits / meaningful.length < 0.5;
}

/**
 * A text layer whose words come out in pieces ("BH ARAT H EAVY ELECTRI CALS"):
 * the PDF places letters one by one, so a phrase search can't match them.
 * Measured as the share of alphabetic words that are 1-2 letter fragments,
 * leaving out the short words real text is full of.
 */
const SHORT_WORDS = new Set(["a", "i", "of", "to", "in", "on", "or", "by", "an", "as", "at", "be", "is", "it", "no", "if", "we", "do", "up", "so", "mm", "cm", "kg", "rs", "nos"]);

export function fragmentShare(text: string): number {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => /^\p{L}+$/u.test(w));
  if (words.length < 20) return 0;
  return words.filter((w) => w.length <= 2 && !SHORT_WORDS.has(w)).length / words.length;
}

export function isLetterSpacedLayer(text: string, threshold = 0.25): boolean {
  return fragmentShare(text) >= threshold;
}

/** Whether the text holds Devanagari letters (Hindi, Marathi): the one script the English OCR reads as garbage. */
export function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

export type OcrReason =
  | "no-text-layer"
  | "image-coverage"
  | "suspect-text-layer"
  | "letter-spaced-text"
  | "text-outside-layer"
  | "all-pages";

/** Share of the page, as dark lettering outside the text layer's words, at or above which a page is OCR'd (see ink.ts). */
export const DEFAULT_UNCOVERED_INK_MAX = 0.006;

/** Pieces of words sitting closer than a word space (see brokenWordJoins in ink.ts) at or above which a page's text layer counts as broken. */
export const DEFAULT_BROKEN_JOINS_MIN = 3;

export interface PagePlan {
  /** Whether to render the page and check it for ink before anything else. */
  checkBlank: boolean;
  /** Why the page will be OCR'd, or null if the text layer is enough. */
  ocrReason: OcrReason | null;
}

/**
 * What to do with a page, from its text layer and image coverage.
 *
 *  - Too little text layer: it is a scan, vector-drawn lettering, or blank.
 *    Render it; if there's no ink it's blank, otherwise OCR it.
 *  - Real text layer but big images too: a typed header over a scanned
 *    annexure, say. OCR it as well, keeping both readings.
 *  - Text layer that doesn't look like text: OCR it as well.
 *  - Otherwise, with ocrAllPages, OCR it anyway: the text layer can lack
 *    text that is plainly visible (vector-drawn lines, letter-spaced words).
 */
export function planPage(
  layerText: string,
  coverage: number,
  options: {
    minTextChars: number;
    mixedImageCoverage: number;
    ocrAllPages?: boolean;
    /**
     * "smart" also OCRs a page whose layer is broken in a way the checks above miss: letter-spaced
     * words, or lettering drawn on the page with no word in the layer (uncoveredInk is the share of
     * the page that is such lettering; see ink.ts). Without it the page's layer is trusted.
     */
    ocrMode?: "all" | "auto" | "smart";
    uncoveredInk?: number;
    uncoveredInkMax?: number;
    brokenJoins?: number;
    brokenJoinsMin?: number;
  }
): PagePlan {
  if (nonSpaceLength(layerText) < options.minTextChars) {
    return { checkBlank: true, ocrReason: "no-text-layer" };
  }
  if (coverage >= options.mixedImageCoverage) {
    return { checkBlank: false, ocrReason: "image-coverage" };
  }
  if (isSuspectTextLayer(layerText)) {
    return { checkBlank: false, ocrReason: "suspect-text-layer" };
  }
  if (options.ocrMode === "smart") {
    if (isLetterSpacedLayer(layerText) || (options.brokenJoins ?? 0) >= (options.brokenJoinsMin ?? DEFAULT_BROKEN_JOINS_MIN)) return { checkBlank: false, ocrReason: "letter-spaced-text" };
    if ((options.uncoveredInk ?? 0) >= (options.uncoveredInkMax ?? DEFAULT_UNCOVERED_INK_MAX)) {
      return { checkBlank: false, ocrReason: "text-outside-layer" };
    }
  }
  return { checkBlank: false, ocrReason: options.ocrAllPages || options.ocrMode === "all" ? "all-pages" : null };
}

/** Low-confidence share (see ocrImageWithConfidence) at or above which a page's first reading is judged to hold a script it couldn't read. Measured: most pages with real Hindi sit above it, and about 1 in 20 English pages do. */
export const HINDI_LOW_CONFIDENCE_MIN = 0.05;

/**
 * Whether a page needs the second reading in English+Hindi: its text layer already holds
 * Devanagari, or the first (English) reading was unsure of an unusual share of its words.
 */
export function needsHindiReading(layerText: string | null, lowConfidenceShare: number): boolean {
  return (layerText !== null && hasDevanagari(layerText)) || lowConfidenceShare >= HINDI_LOW_CONFIDENCE_MIN;
}
