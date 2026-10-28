import { parsePgm, type Pgm } from "./classify";
import { renderGray, textBoxes, type PageBoxes } from "./pdf";

/**
 * Looks for lettering the text layer does not hold: text drawn as vector
 * shapes, or words missing from the layer. Both leave dark marks on the
 * rendered page where the layer has no word. The page is rendered, then the
 * dark pixels are counted that sit outside every word box of the text layer
 * and are not part of a long straight line (table borders, underlines, filled
 * bars). What remains is lettering the layer cannot account for.
 */

/** Resolution of the check: enough to tell lettering from a line, much cheaper than OCR's 300. */
export const INK_DPI = 100;

/** A dark run at least this long (inches) in one direction is a ruled line, not a letter. */
const LINE_INCHES = 0.6;

/** Word boxes are grown by this many inches so antialiased edges and slightly off boxes don't count as outside ink. */
const MARGIN_INCHES = 0.03;

export function inkOutsideText(pgm: Pgm, page: PageBoxes, dpi = INK_DPI): number {
  const { width, height, pixels } = pgm;
  if (width === 0 || height === 0) return 0;
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < dark.length; i++) dark[i] = pixels[i] < 200 ? 1 : 0;

  // Remove long horizontal and vertical runs.
  const minRun = Math.round(LINE_INCHES * dpi);
  const skip = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (!dark[y * width + x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < width && dark[y * width + end]) end++;
      if (end - x >= minRun) for (let k = x; k < end; k++) skip[y * width + k] = 1;
      x = end;
    }
  }
  for (let x = 0; x < width; x++) {
    let y = 0;
    while (y < height) {
      if (!dark[y * width + x]) {
        y++;
        continue;
      }
      let end = y;
      while (end < height && dark[end * width + x]) end++;
      if (end - y >= minRun) for (let k = y; k < end; k++) skip[k * width + x] = 1;
      y = end;
    }
  }

  // Remove everything inside the text layer's word boxes (slightly grown).
  const sx = width / page.width;
  const sy = height / page.height;
  const margin = Math.ceil(MARGIN_INCHES * dpi);
  for (const w of page.words) {
    const x0 = Math.max(0, Math.floor(w.xMin * sx) - margin);
    const x1 = Math.min(width, Math.ceil(w.xMax * sx) + margin);
    const y0 = Math.max(0, Math.floor(w.yMin * sy) - margin);
    const y1 = Math.min(height, Math.ceil(w.yMax * sy) + margin);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) skip[y * width + x] = 1;
  }

  let outside = 0;
  for (let i = 0; i < dark.length; i++) if (dark[i] && !skip[i]) outside++;
  return outside / dark.length;
}

/**
 * Counts places where a short piece of a word sits closer to its neighbour than
 * the page's usual word space. A PDF that places letters one by one ("De sc
 * ript ion", "U nit") gets split into pieces by the extractor, but the gap
 * between the pieces stays well under the gap between true words on that page.
 * Measured against the page's own median gap, so tight fonts and justified
 * text don't trip it.
 */
export function brokenWordJoins(page: PageBoxes, tightRatio = 0.45): number {
  const pairs: Array<{ gap: number; a: string; b: string }> = [];
  for (let i = 1; i < page.words.length; i++) {
    const a = page.words[i - 1];
    const b = page.words[i];
    const height = Math.max(a.yMax - a.yMin, b.yMax - b.yMin);
    if (height <= 0 || Math.abs(a.yMin - b.yMin) > 0.3 * height) continue;
    const gap = b.xMin - a.xMax;
    if (gap >= 0 && gap < height) pairs.push({ gap, a: a.text, b: b.text });
  }
  if (pairs.length < 10) return 0;
  const sorted = pairs.map((p) => p.gap).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const piece = (t: string) => /^\p{L}{1,3}$/u.test(t);
  let count = 0;
  for (const p of pairs) {
    if (p.gap < tightRatio * median && (piece(p.a) || piece(p.b))) count++;
  }
  return count;
}

/** Per page, the share of the page that is dark lettering outside the text layer's words. Sequential; the indexer calls inkOutsideText itself so it can share its CPU limiter. */
export async function uncoveredInkShare(file: string, pageCount: number, timeoutMs: number): Promise<number[]> {
  const boxes = await textBoxes(file, timeoutMs * 2);
  const out: number[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const page = boxes[p - 1];
    if (!page) {
      out.push(0);
      continue;
    }
    const pgm = parsePgm(await renderGray(file, p, INK_DPI, timeoutMs));
    out.push(inkOutsideText(pgm, page));
  }
  return out;
}
