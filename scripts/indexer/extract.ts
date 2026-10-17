import fs from "node:fs/promises";
import path from "node:path";
import type { PageSource } from "../../src/lib/search/schema";
import { inkFraction, parsePgm, planPage, type OcrReason } from "./classify";
import { settingsKey, type IndexerConfig } from "./config";
import { readPageLabels } from "./labels";
import type { OcrCache } from "./ocrCache";
import {
  imageCoverage,
  ocrImage,
  pdfInfo,
  renderGray,
  renderPng,
  textLayerAll,
  textLayerPage,
} from "./pdf";
import type { ExtractedDocument, ExtractedPage } from "./store";

/** Low resolution is plenty to tell "any ink" from "no ink", and fast. */
const BLANK_CHECK_DPI = 50;

export interface ExtractContext {
  config: IndexerConfig;
  /** Shared across all documents so the whole run respects one CPU budget. */
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  ocrCache: OcrCache;
  tempDir: string;
  log: (message: string) => void;
  stats: { ocrRun: number; ocrCached: number };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * OCR text for one page: from the cache if this exact file content was OCR'd
 * before with the same settings, otherwise render + tesseract.
 */
export async function ocrPage(
  file: string,
  sha256: string,
  pageNo: number,
  ctx: ExtractContext
): Promise<string> {
  const { ocrLang, ocrDpi, pageTimeoutMs } = ctx.config;
  const cached = ctx.ocrCache.get(sha256, pageNo, ocrLang, ocrDpi);
  if (cached !== undefined) {
    ctx.stats.ocrCached++;
    return cached;
  }

  const text = await ctx.limit(async () => {
    const base = path.join(ctx.tempDir, `${sha256.slice(0, 16)}-p${pageNo}`);
    try {
      const png = await renderPng(file, pageNo, ocrDpi, base, pageTimeoutMs);
      return await ocrImage(png, ocrLang, pageTimeoutMs);
    } finally {
      await fs.rm(`${base}.png`, { force: true });
    }
  });
  ctx.ocrCache.put(sha256, pageNo, ocrLang, ocrDpi, text);
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

  const pages = await Promise.all(
    Array.from({ length: pageCount }, async (_, i): Promise<ExtractedPage> => {
      const pageNo = i + 1;
      const layerText = layers[i];
      const plan = layerErrors[i]
        ? { checkBlank: true, ocrReason: "no-text-layer" as OcrReason }
        : planPage(layerText, coverage[i], { ...config, ocrAllPages: config.ocrPages === "all" });
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

      try {
        const ocrText = await ocrPage(file, sha256, pageNo, ctx);
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
