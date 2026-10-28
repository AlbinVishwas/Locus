import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BROKEN_JOINS_MIN,
  fragmentShare,
  hasDevanagari,
  isLetterSpacedLayer,
  needsHindiReading,
  planPage,
  type Pgm,
} from "./classify";
import { loadConfig, loadUploadConfig, settingsKey } from "./config";
import { createLimiter } from "./exec";
import { brokenWordJoins, inkOutsideText } from "./ink";
import type { PageBoxes, WordBox } from "./pdf";

const options = { minTextChars: 30, mixedImageCoverage: 0.3, ocrMode: "smart" as const };
const realText = "The bidder shall submit the earnest money deposit before the due date, along with the tender fee.";

function words(texts: string[], gaps: number[], height = 10): WordBox[] {
  let x = 50;
  return texts.map((text, i) => {
    const box = { text, xMin: x, xMax: x + text.length * 5, yMin: 100, yMax: 100 + height };
    x = box.xMax + (gaps[i] ?? 3);
    return box;
  });
}

describe("smart OCR policy", () => {
  it("trusts an ordinary text page", () => {
    expect(planPage(realText, 0.02, options)).toEqual({ checkBlank: false, ocrReason: null });
  });

  it("OCRs a page whose words come out in pieces (letter-spaced layer)", () => {
    const broken = "BH ARAT H EAVY ELECTRI CALS LI M I TED TI RUCH I RAPPALLI ".repeat(4);
    expect(isLetterSpacedLayer(broken)).toBe(true);
    expect(planPage(broken, 0, options).ocrReason).toBe("letter-spaced-text");
  });

  it("OCRs a page with a few broken header words among normal text, found from the word positions", () => {
    expect(planPage(realText, 0, { ...options, brokenJoins: DEFAULT_BROKEN_JOINS_MIN }).ocrReason).toBe("letter-spaced-text");
    expect(planPage(realText, 0, { ...options, brokenJoins: DEFAULT_BROKEN_JOINS_MIN - 1 }).ocrReason).toBeNull();
  });

  it("OCRs a page with lettering outside the text layer, not one with a few ruled lines", () => {
    expect(planPage(realText, 0, { ...options, uncoveredInk: 0.04 }).ocrReason).toBe("text-outside-layer");
    expect(planPage(realText, 0, { ...options, uncoveredInk: 0.001 }).ocrReason).toBeNull();
  });

  it("keeps the earlier rules: no text layer, large images", () => {
    expect(planPage("  3 ", 0, options).ocrReason).toBe("no-text-layer");
    expect(planPage(realText, 0.8, options).ocrReason).toBe("image-coverage");
  });

  it("with OCR_PAGES=all every page that has text is read", () => {
    expect(planPage(realText, 0, { ...options, ocrMode: "all" }).ocrReason).toBe("all-pages");
  });

  it("does not take ordinary short words for fragments", () => {
    expect(fragmentShare(realText.repeat(3))).toBe(0);
  });
});

describe("brokenWordJoins", () => {
  const wide = (n: number) => Array.from({ length: n }, () => "word");
  const page = (w: WordBox[]): PageBoxes => ({ width: 600, height: 800, words: w });

  it("counts pieces sitting much closer than a word space on a page that otherwise spaces words normally", () => {
    const texts = [...wide(14), "De", "sc", "ript", "ion"];
    const gaps = [...wide(14).map(() => 3), 1, 1, 1, 3];
    expect(brokenWordJoins(page(words(texts, gaps)))).toBe(3);
  });

  it("is not set off by a justified line, whose gaps are wide but uneven", () => {
    const texts = [...wide(14), "to", "be", "paid", "in"];
    const gaps = [...wide(14).map(() => 3), 1.9, 1.9, 1.9, 3];
    expect(brokenWordJoins(page(words(texts, gaps)))).toBe(0);
  });

  it("says nothing about a page with too few words to know its word space", () => {
    expect(brokenWordJoins(page(words(["De", "sc", "ript"], [1, 1, 1])))).toBe(0);
  });
});

describe("inkOutsideText", () => {
  function image(width: number, height: number, draw: (set: (x: number, y: number) => void) => void): Pgm {
    const pixels = new Uint8Array(width * height).fill(255);
    draw((x, y) => (pixels[y * width + x] = 0));
    return { width, height, maxValue: 255, pixels };
  }
  const page = (words: WordBox[]): PageBoxes => ({ width: 200, height: 200, words });

  it("counts lettering with no word under it", () => {
    const pgm = image(200, 200, (set) => {
      for (let y = 20; y < 30; y++) for (let x = 20; x < 40; x++) set(x, y);
    });
    expect(inkOutsideText(pgm, page([]), 100)).toBeGreaterThan(0.004);
  });

  it("ignores ink under a word box and ruled lines", () => {
    const pgm = image(200, 200, (set) => {
      for (let y = 20; y < 30; y++) for (let x = 20; x < 40; x++) set(x, y);
      for (let x = 0; x < 200; x++) set(x, 100);
    });
    const words: WordBox[] = [{ text: "word", xMin: 18, xMax: 42, yMin: 18, yMax: 32 }];
    expect(inkOutsideText(pgm, page(words), 100)).toBe(0);
  });
});

describe("needsHindiReading / hasDevanagari", () => {
  it("asks for the Hindi reading on Devanagari in the layer or an unsure English reading", () => {
    expect(hasDevanagari("निविदा")).toBe(true);
    expect(hasDevanagari("tender")).toBe(false);
    expect(needsHindiReading("निविदा tender", 0)).toBe(true);
    expect(needsHindiReading(null, 0.2)).toBe(true);
    expect(needsHindiReading(null, 0.01)).toBe(false);
    expect(needsHindiReading("tender", 0.01)).toBe(false);
  });
});

describe("createLimiter priority", () => {
  it("starts a higher-priority task before queued lower-priority ones, in order among equals", async () => {
    const limit = createLimiter(1);
    const started: string[] = [];
    const gate: { open: () => void } = { open: () => {} };
    const first = limit(() => new Promise<void>((resolve) => (gate.open = resolve)));
    const task = (name: string, priority?: number) =>
      limit(async () => {
        started.push(name);
      }, priority);
    const rest = [task("ocr-1", -1), task("ocr-2", -1), task("text", 0), task("ocr-3", -1), task("text-2", 0)];
    gate.open();
    await Promise.all([first, ...rest]);
    expect(started).toEqual(["text", "text-2", "ocr-1", "ocr-2", "ocr-3"]);
  });
});

describe("upload config", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["OCR_PAGES", "OCR_LANG", "OCR_LANG_FALLBACK", "OCR_CONCURRENCY", "OCR_NICE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to smart pages, English first with a Hindi fallback, every core, lowered priority", () => {
    for (const k of ["OCR_PAGES", "OCR_LANG", "OCR_LANG_FALLBACK", "OCR_CONCURRENCY", "OCR_NICE"]) delete process.env[k];
    const c = loadUploadConfig();
    expect(c.ocrPages).toBe("smart");
    expect(c.ocrLang).toBe("eng");
    expect(c.ocrLangFallback).toBe("eng+hin");
    expect(c.concurrency).toBeGreaterThanOrEqual(1);
    expect(c.ocrNice).toBe(10);
  });

  it("is overridden by the settings people already know", () => {
    process.env.OCR_PAGES = "all";
    process.env.OCR_LANG = "eng+hin";
    process.env.OCR_CONCURRENCY = "3";
    process.env.OCR_NICE = "0";
    const c = loadUploadConfig();
    expect(c.ocrPages).toBe("all");
    expect(c.ocrLang).toBe("eng+hin");
    expect(c.ocrLangFallback).toBeNull();
    expect(c.concurrency).toBe(3);
    expect(c.ocrNice).toBe(0);
  });

  it("leaves the library indexer as it was, down to the key its documents are stored with", () => {
    for (const k of ["OCR_PAGES", "OCR_LANG", "OCR_LANG_FALLBACK", "OCR_CONCURRENCY", "OCR_NICE"]) delete process.env[k];
    const c = loadConfig();
    expect(c.ocrPages).toBe("all");
    expect(c.ocrLang).toBe("eng+hin");
    expect(c.ocrLangFallback).toBeNull();
    expect(JSON.parse(settingsKey(c))).toEqual({ v: 1, lang: "eng+hin", dpi: 300, pages: "all", minText: 30, mixed: 0.3, blank: 0.00005 });
  });
});
