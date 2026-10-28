import { describe, expect, it } from "vitest";
import { DEFAULT_UNCOVERED_INK_MAX, type Pgm } from "./classify";
import { inkOutsideText } from "./ink";
import type { PageBoxes } from "./pdf";

/**
 * The shortcut the library's smart check takes (skip the ruled-line passes when the dark lettering outside the word boxes
 * is already under the threshold) must never change a decision: same answer as the exact value, on every page.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPage(seed: number): { pgm: Pgm; boxes: PageBoxes } {
  const r = rng(seed);
  const width = 200;
  const height = 260;
  const pixels = new Uint8Array(width * height).fill(255);
  const dark = (x: number, y: number) => {
    if (x >= 0 && x < width && y >= 0 && y < height) pixels[y * width + x] = 0;
  };
  const words: PageBoxes["words"] = [];
  // Typed words: a box, and ink inside it.
  const lines = 3 + Math.floor(r() * 10);
  for (let l = 0; l < lines; l++) {
    let x = 10;
    const y = 15 + l * 20;
    while (x < 170) {
      const w = 8 + Math.floor(r() * 30);
      words.push({ text: "word", xMin: x * 0.72, xMax: (x + w) * 0.72, yMin: y * 0.72, yMax: (y + 9) * 0.72 });
      for (let k = 0; k < w * 3; k++) dark(x + Math.floor(r() * w), y + Math.floor(r() * 9));
      x += w + 6;
    }
  }
  // Sometimes lettering outside any box (the thing being looked for), sometimes ruled lines, sometimes both.
  const mode = Math.floor(r() * 4);
  const scatter = Math.floor(r() * 2500); // drawn once (not on every pass of the loop)
  if (mode === 1 || mode === 3) for (let k = 0; k < scatter; k++) dark(Math.floor(r() * width), Math.floor(r() * height));
  if (mode === 2 || mode === 3) for (const y of [30, 90, 200]) for (let x = 5; x < 195; x++) dark(x, y);
  return { pgm: { width, height, maxValue: 255, pixels }, boxes: { width: width * 0.72, height: height * 0.72, words } };
}

describe("inkOutsideText with a stop-below threshold", () => {
  it("makes the same decision as the exact value on 300 varied pages, and is exact whenever it isn't under the threshold", () => {
    let under = 0;
    let over = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { pgm, boxes } = randomPage(seed);
      const exact = inkOutsideText(pgm, boxes, 100);
      const quick = inkOutsideText(pgm, boxes, 100, DEFAULT_UNCOVERED_INK_MAX);
      expect(quick >= DEFAULT_UNCOVERED_INK_MAX, `page ${seed}`).toBe(exact >= DEFAULT_UNCOVERED_INK_MAX);
      expect(quick).toBeGreaterThanOrEqual(exact);
      if (quick >= DEFAULT_UNCOVERED_INK_MAX) {
        expect(quick).toBe(exact);
        over++;
      } else under++;
    }
    expect(under).toBeGreaterThan(30); // the pages exercise both sides
    expect(over).toBeGreaterThan(30);
  });
});
