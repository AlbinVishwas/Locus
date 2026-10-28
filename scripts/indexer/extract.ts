import fs from "node:fs/promises";
import path from "node:path";
import type { PageSource } from "../../src/lib/search/schema";
import { inkFraction, needsHindiReading, parsePgm, planPage, type OcrReason } from "./classify";
import { brokenWordJoins, INK_DPI, inkOutsideText } from "./ink";
import { settingsKey, type IndexerConfig } from "./config";
import { readPageLabels } from "./labels";
import type { OcrCache } from "./ocrCache";
import {
  imageCoverage,
  ocrImage,
  ocrImageWithConfidence,
  pdfInfo,
  renderGray,
  renderForOcr,
  textBoxes,
  textLayerAll,
  textLayerPage,
  type PageBoxes,
} from "./pdf";
import type { ExtractedDocument, ExtractedPage } from "./store";

/** Low resolution is plenty to tell "any ink" from "no ink", and fast. */
const BLANK_CHECK_DPI = 50;

export interface ExtractContext {
  config: IndexerConfig;
  /** Shared across all documents so the whole run respects one CPU budget. */
  limit: <T>(task: () => Promise<T>, priority?: number) => Promise<T>;
  ocrCache: OcrCache;
  tempDir: string;
  log: (message: string) => void;
  stats: {
    ocrRun: number;
    ocrCached: number;
    /** Summed across pages (CPU-time style, not wall time): rendering and tesseract. Only filled when present. */
    renderMs?: number;
    tesseractMs?: number;
    /** Summed time of the text-extraction steps of extractDocument (pdfinfo, labels, text layer, images, blank checks). */
    textMs?: number;
    /** Pages read a second time in the fallback language because they showed Devanagari. */
    fallbackReads?: number;
  };
  /**
   * Stop short of running OCR: a page that needs it comes back with source
   * 'pending-ocr' instead of 'ocr'/'text+ocr'. Used for uploads, where OCR
   * runs afterwards as a background queue so a slow page doesn't hold up
   * the rest of the document (or the other pages' text-layer search
   * results) from being written and searchable immediately.
   */
  skipOcr?: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * OCR text for one page: from the cache if this exact file content was OCR'd
 * before with the same settings, otherwise render + tesseract.
 */
/** OCR runs behind the text-reading steps of other files in the same limiter (see createLimiter). */
const OCR_PRIORITY = -1;

export async function ocrPage(
  file: string,
  sha256: string,
  pageNo: number,
  ctx: ExtractContext,
  /** The page's text layer, when it has one: Devanagari in it asks for the Hindi reading. */
  layerText: string | null = null
): Promise<string> {
  const { ocrLang, ocrLangFallback, ocrDpi, pageTimeoutMs } = ctx.config;
  const ocrNice = ctx.config.ocrNice ?? 0;

  // A page already read in the fallback language was one that needed it; one read only in the first
  // language did not.
  if (ocrLangFallback) {
    const hindi = ctx.ocrCache.get(sha256, pageNo, ocrLangFallback, ocrDpi);
    if (hindi !== undefined) {
      ctx.stats.ocrCached++;
      return hindi;
    }
  }
  const cached = ctx.ocrCache.get(sha256, pageNo, ocrLang, ocrDpi);
  if (cached !== undefined) {
    ctx.stats.ocrCached++;
    return cached;
  }

  const { text, lang } = await ctx.limit(async () => {
    const base = path.join(ctx.tempDir, `${sha256.slice(0, 16)}-p${pageNo}`);
    try {
      const t0 = Date.now();
      const png = await renderForOcr(file, pageNo, ocrDpi, base, pageTimeoutMs, ocrNice);
      const t1 = Date.now();
      let reading: { text: string; lang: string };
      if (ocrLangFallback) {
        const first = await ocrImageWithConfidence(png, ocrLang, pageTimeoutMs, ocrNice, ocrDpi);
        if (needsHindiReading(layerText, first.lowConfidenceShare)) {
          reading = { text: await ocrImage(png, ocrLangFallback, pageTimeoutMs, ocrNice, ocrDpi), lang: ocrLangFallback };
          if (ctx.stats.fallbackReads !== undefined) ctx.stats.fallbackReads++;
        } else {
          reading = { text: first.text, lang: ocrLang };
        }
      } else {
        reading = { text: await ocrImage(png, ocrLang, pageTimeoutMs, ocrNice, ocrDpi), lang: ocrLang };
      }
      if (ctx.stats.renderMs !== undefined) ctx.stats.renderMs += t1 - t0;
      if (ctx.stats.tesseractMs !== undefined) ctx.stats.tesseractMs += Date.now() - t1;
      return reading;
    } finally {
      await fs.rm(`${base}.pgm`, { force: true });
    }
  }, OCR_PRIORITY);
  ctx.ocrCache.put(sha256, pageNo, lang, ocrDpi, text);
  ctx.stats.ocrRun++;
  return text;
}

/**
 * Extracts every page of one PDF. Never throws for a bad page: each page ends
 * up with a source (text / text+ocr / ocr / blank / failed) and, if something
 * went wrong, an error message. Only a PDF that can't be opened at all comes
 * back with no pages, and then with `error` set so the report shows it.
 */
export async function extractDocument(
  file: string,
  sha256: string,
  sizeBytes: number,
  ctx: ExtractContext
): Promise<ExtractedDocument> {
  const { config, limit, log } = ctx;
  const filename = path.basename(file);
  const base = { filename, sha256, sizeBytes, ocrLang: config.ocrLang, settings: settingsKey(config) };

  let info;
  try {
    info = await limit(() => pdfInfo(file, config.pageTimeoutMs));
  } catch (err) {
    log(`  ! ${filename}: cannot open PDF: ${message(err)}`);
    return { ...base, pageCount: 0, error: `cannot open PDF: ${message(err)}`, pages: [] };
  }
  const { pageCount, pageAreas } = info;

  let labels: (string | null)[] | null = null;
  try {
    labels = await limit(() => readPageLabels(file, config.pageTimeoutMs));
  } catch (err) {
    log(`  ! ${filename}: page labels unreadable (${message(err)}); physical numbers only`);
  }

  // Text layer: one call for the whole file, or page by page if that fails
  // or the page count doesn't line up.
  const layers: string[] = new Array(pageCount).fill("");
  const layerErrors: (string | null)[] = new Array(pageCount).fill(null);
  let whole: string[] | null = null;
  try {
    whole = await limit(() => textLayerAll(file, pageCount, config.pageTimeoutMs * 2));
  } catch (err) {
    log(`  ! ${filename}: whole-file text extraction failed (${message(err)}); retrying per page`);
  }
  if (whole) {
    whole.forEach((t, i) => (layers[i] = t));
  } else {
    await Promise.all(
      layers.map((_, i) =>
        limit(() => textLayerPage(file, i + 1, config.pageTimeoutMs)).then(
          (t) => (layers[i] = t),
          (err) => (layerErrors[i] = `text layer: ${message(err)}`)
        )
      )
    );
  }

  // Image coverage. If it can't be measured we can't rule out a scanned
  // region, so every page is OCR'd rather than risk missing one.
  let coverage: number[];
  let coverageFailed = false;
  try {
    coverage = await limit(() => imageCoverage(file, pageAreas, config.pageTimeoutMs));
  } catch (err) {
    log(`  ! ${filename}: image list failed (${message(err)}); OCR'ing every page`);
    coverage = new Array(pageCount).fill(1);
    coverageFailed = true;
  }

  // Smart policy: where every word of the layer sits, to find pieces of broken words and, against a
  // render of the page, lettering the layer doesn't hold. Without the boxes the check can't be made,
  // so pages with a layer are all read, as with OCR_PAGES=all.
  let boxes: PageBoxes[] | null = null;
  if (config.ocrPages === "smart") {
    try {
      boxes = await limit(() => textBoxes(file, config.pageTimeoutMs * 2));
    } catch (err) {
      log(`  ! ${filename}: word positions failed (${message(err)}); OCR'ing every page that has text`);
    }
  }
  const smartUnchecked = config.ocrPages === "smart" && boxes === null;

  const pages = await Promise.all(
    Array.from({ length: pageCount }, async (_, i): Promise<ExtractedPage> => {
      const pageNo = i + 1;
      const layerText = layers[i];
      const planOptions = {
        ...config,
        ocrAllPages: config.ocrPages === "all" || smartUnchecked,
        ocrMode: config.ocrPages === "smart" && !smartUnchecked ? ("smart" as const) : undefined,
        brokenJoins: boxes?.[i] ? brokenWordJoins(boxes[i]) : 0,
      };
      let plan = layerErrors[i]
        ? { checkBlank: true, ocrReason: "no-text-layer" as OcrReason }
        : planPage(layerText, coverage[i], planOptions);
      if (!layerErrors[i] && planOptions.ocrMode === "smart" && !plan.ocrReason && boxes?.[i]) {
        // The layer looks fine so far; check the page for lettering it doesn't account for.
        try {
          const pgm = parsePgm(await limit(() => renderGray(file, pageNo, INK_DPI, config.pageTimeoutMs)));
          plan = planPage(layerText, coverage[i], { ...planOptions, uncoveredInk: inkOutsideText(pgm, boxes[i]) });
        } catch {
          plan = { checkBlank: false, ocrReason: "all-pages" as OcrReason };
        }
      }
      const page: ExtractedPage = {
        pageNo,
        pageLabel: labels?.[i] ?? null,
        source: "text",
        ocrReason: plan.ocrReason === "image-coverage" && coverageFailed ? "image-check-failed" : plan.ocrReason,
        imageCoverage: coverageFailed ? 0 : coverage[i],
        layerText,
        ocrText: null,
        error: layerErrors[i],
      };

      if (plan.checkBlank) {
        try {
          const pgm = parsePgm(
            await limit(() => renderGray(file, pageNo, BLANK_CHECK_DPI, config.pageTimeoutMs))
          );
          if (inkFraction(pgm) < config.blankMaxInk) {
            return { ...page, source: "blank", ocrReason: null };
          }
        } catch (err) {
          return { ...page, source: "failed", error: join(page.error, `render: ${message(err)}`) };
        }
      }

      if (!plan.ocrReason) return page;

      if (ctx.skipOcr) {
        return { ...page, source: "pending-ocr" };
      }

      try {
        const ocrText = await ocrPage(file, sha256, pageNo, ctx, layerText);
        const source: PageSource = plan.ocrReason === "no-text-layer" ? "ocr" : "text+ocr";
        return { ...page, source, ocrText };
      } catch (err) {
        log(`  ! ${filename} p${pageNo}: OCR failed: ${message(err)}`);
        // The text layer (if any) is still stored and searchable; the page
        // is marked failed so the report shows it wasn't fully read.
        return { ...page, source: "failed", error: join(page.error, `ocr: ${message(err)}`) };
      }
    })
  );

  return { ...base, pageCount, error: null, pages };
}

function join(a: string | null, b: string): string {
  return a ? `${a}; ${b}` : b;
}

/**
 * The final page source once a 'pending-ocr' page's OCR comes back with
 * text. Takes the stored ocrReason string (ExtractedPage.ocrReason is a
 * plain `string | null`, wider than the OcrReason union, since it round-
 * trips through the database) rather than OcrReason itself.
 */
export function sourceAfterOcr(ocrReason: string | null): PageSource {
  return ocrReason === "no-text-layer" ? "ocr" : "text+ocr";
}
