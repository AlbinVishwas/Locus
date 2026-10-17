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

export type OcrReason = "no-text-layer" | "image-coverage" | "suspect-text-layer" | "all-pages";

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
  options: { minTextChars: number; mixedImageCoverage: number; ocrAllPages?: boolean }
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
  return { checkBlank: false, ocrReason: options.ocrAllPages ? "all-pages" : null };
}
