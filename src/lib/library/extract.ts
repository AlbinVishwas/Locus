import { inkFraction, parsePgm, planPage, type OcrReason } from "../../../scripts/indexer/classify";
import { loadConfig, type IndexerConfig } from "../../../scripts/indexer/config";
import { runText, ToolError } from "../../../scripts/indexer/exec";
import { ocrPage, sourceAfterOcr, type ExtractContext } from "../../../scripts/indexer/extract";
import { readPageLabels } from "../../../scripts/indexer/labels";
import type { OcrCache } from "../../../scripts/indexer/ocrCache";
import { imageCoverage, renderGray, textLayerPage } from "../../../scripts/indexer/pdf";
import type { ExtractedPage } from "../../../scripts/indexer/store";
import { MAX_PAGE_NO } from "./schema";
import { SourceFileError } from "./sources/types";

/**
 * Page-by-page extraction for library files, built from the same pieces as
 * the existing indexer (classify.ts, pdf.ts, ocrPage) -- which are reused
 * unchanged -- but shaped so no step holds a whole large PDF, or its whole
 * text, in memory:
 *
 *   - the text layer comes from pdftotext in windows of `pageWindow` pages
 *     (extract.ts's whole-file call buffers every page's text at once);
 *   - pages are yielded as each window finishes, and the caller writes them
 *     to the index in chunks;
 *   - printed page labels need the whole file in memory (pdf.js), so they're
 *     only read for files up to `labelsMaxBytes`.
 *
 * Encryption: a PDF that opens without a password but restricts
 * printing/copying/editing is indexed (its text is readable); one that
 * needs a password to open is skipped with kind "encrypted".
 */

const BLANK_CHECK_DPI = 50;

export interface PdfInspection {
  pageCount: number;
  pageAreas: number[];
  /** "restricted": encrypted, opens without a password, with usage restrictions. */
  encryption: "none" | "restricted";
}

function toolMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** pdfinfo, interpreted: page count and sizes, encryption -- or why the file can't be read at all. */
export async function inspectPdf(file: string, timeoutMs: number): Promise<PdfInspection> {
  let out: string;
  try {
    out = await runText("pdfinfo", ["-f", "1", "-l", "1000000", file], { timeoutMs });
  } catch (err) {
    const msg = toolMessage(err);
    if (err instanceof ToolError && err.timedOut) throw new SourceFileError("timeout", msg);
    if (/incorrect password/i.test(msg)) {
      throw new SourceFileError("encrypted", "skipped: encrypted, needs a password to open");
    }
    throw new SourceFileError("corrupt", msg);
  }
  const pagesLine = out.match(/^Pages:\s+(\d+)/m);
  if (!pagesLine) throw new SourceFileError("corrupt", "pdfinfo did not report a page count");
  const pageCount = Number(pagesLine[1]);
  if (pageCount > MAX_PAGE_NO) {
    throw new SourceFileError("too-many-pages", `skipped: ${pageCount} pages (the library supports up to ${MAX_PAGE_NO})`);
  }
  const pageAreas = new Array<number>(pageCount).fill(0);
  for (const m of out.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    const index = Number(m[1]) - 1;
    if (index >= 0 && index < pageCount) pageAreas[index] = (Number(m[2]) / 72) * (Number(m[3]) / 72);
  }
  const encrypted = /^Encrypted:\s+yes/m.test(out);
  return { pageCount, pageAreas, encryption: encrypted ? "restricted" : "none" };
}

/** pdftotext for pages [first, last]: one entry per page, or null if the page breaks don't line up. */
async function textWindow(file: string, first: number, last: number, timeoutMs: number): Promise<string[] | null> {
  const out = await runText("pdftotext", ["-enc", "UTF-8", "-f", String(first), "-l", String(last), file, "-"], { timeoutMs });
  const parts = out.split("\f");
  const n = last - first + 1;
  if (parts.length !== n + 1 || parts[n].trim() !== "") return null;
  return parts.slice(0, n);
}

export interface LibraryExtractOptions {
  ocrPages: "auto" | "all";
  ocrLang: string;
  ocrDpi: number;
  pageTimeoutMs: number;
  pageWindow: number;
  labelsMaxBytes: number;
  /** Absolute time (ms) after which the file is abandoned as a timeout. */
  deadline: number;
  limit: <T>(task: () => Promise<T>) => Promise<T>;
  ocrCache: OcrCache;
  /** Per-file scratch folder on the external drive. */
  tempDir: string;
  signal: AbortSignal;
  stats: { ocrRun: number; ocrCached: number };
  log?: (message: string) => void;
}

/** The thresholds the existing indexer uses (MIN_TEXT_CHARS etc., env-overridable there), so a page is classified the same way in both. */
function thresholds(): Pick<IndexerConfig, "minTextChars" | "mixedImageCoverage" | "blankMaxInk"> {
  const c = loadConfig();
  return { minTextChars: c.minTextChars, mixedImageCoverage: c.mixedImageCoverage, blankMaxInk: c.blankMaxInk };
}

export function extractSettingsKey(o: Pick<LibraryExtractOptions, "ocrPages" | "ocrLang" | "ocrDpi">): string {
  const t = thresholds();
  return JSON.stringify({ lib: 1, lang: o.ocrLang, dpi: o.ocrDpi, pages: o.ocrPages, minText: t.minTextChars, mixed: t.mixedImageCoverage, blank: t.blankMaxInk });
}

function checkTime(o: LibraryExtractOptions): void {
  if (o.signal.aborted) throw new Error("aborted");
  if (Date.now() > o.deadline) throw new SourceFileError("timeout", "skipped: file took longer than LIBRARY_FILE_TIMEOUT_MS");
}

export async function* extractPages(
  file: string,
  sha256: string,
  sizeBytes: number,
  info: PdfInspection,
  o: LibraryExtractOptions
): AsyncGenerator<ExtractedPage> {
  const t = thresholds();
  const log = o.log ?? (() => {});
  const { pageCount, pageAreas } = info;

  let labels: (string | null)[] | null = null;
  if (sizeBytes <= o.labelsMaxBytes) {
    try {
      labels = await o.limit(() => readPageLabels(file, o.pageTimeoutMs));
    } catch (err) {
      log(`page labels unreadable (${toolMessage(err)}); physical numbers only`);
    }
  }

  // Image coverage for the whole file in one listing: one short line per
  // image, never page content. If it fails, every page is OCR'd rather than
  // risk missing a scanned region.
  let coverage: number[];
  let coverageFailed = false;
  try {
    coverage = await o.limit(() => imageCoverage(file, pageAreas, o.pageTimeoutMs));
  } catch (err) {
    log(`image list failed (${toolMessage(err)}); OCR'ing every page`);
    coverage = new Array(pageCount).fill(1);
    coverageFailed = true;
  }

  const ocrCtx: ExtractContext = {
    config: { ...loadConfig(), ocrLang: o.ocrLang, ocrDpi: o.ocrDpi, pageTimeoutMs: o.pageTimeoutMs },
    limit: o.limit,
    ocrCache: o.ocrCache,
    tempDir: o.tempDir,
    log,
    stats: o.stats,
  };

  for (let first = 1; first <= pageCount; first += o.pageWindow) {
    checkTime(o);
    const last = Math.min(pageCount, first + o.pageWindow - 1);
    const layers: string[] = new Array(last - first + 1).fill("");
    const layerErrors: (string | null)[] = new Array(last - first + 1).fill(null);
    let window: string[] | null = null;
    try {
      window = await o.limit(() => textWindow(file, first, last, o.pageTimeoutMs));
    } catch (err) {
      log(`text for pages ${first}-${last} failed (${toolMessage(err)}); retrying per page`);
    }
    if (window) {
      window.forEach((text, i) => (layers[i] = text));
    } else {
      await Promise.all(
        layers.map((_, i) =>
          o.limit(() => textLayerPage(file, first + i, o.pageTimeoutMs)).then(
            (text) => (layers[i] = text),
            (err) => (layerErrors[i] = `text layer: ${toolMessage(err)}`)
          )
        )
      );
    }

    const pages = await Promise.all(
      layers.map(async (layerText, i): Promise<ExtractedPage> => {
        const pageNo = first + i;
        const idx = pageNo - 1;
        const plan = layerErrors[i]
          ? { checkBlank: true, ocrReason: "no-text-layer" as OcrReason }
          : planPage(layerText, coverage[idx], { ...t, ocrAllPages: o.ocrPages === "all" });
        const page: ExtractedPage = {
          pageNo,
          pageLabel: labels?.[idx] ?? null,
          source: "text",
          ocrReason: plan.ocrReason === "image-coverage" && coverageFailed ? "image-check-failed" : plan.ocrReason,
          imageCoverage: coverageFailed ? 0 : coverage[idx],
          layerText,
          ocrText: null,
          error: layerErrors[i],
        };
        if (plan.checkBlank) {
          try {
            const pgm = parsePgm(await o.limit(() => renderGray(file, pageNo, BLANK_CHECK_DPI, o.pageTimeoutMs)));
            if (inkFraction(pgm) < t.blankMaxInk) return { ...page, source: "blank", ocrReason: null };
          } catch (err) {
            return { ...page, source: "failed", error: join(page.error, `render: ${toolMessage(err)}`) };
          }
        }
        if (!plan.ocrReason) return page;
        if (o.signal.aborted) throw new Error("aborted");
        try {
          // ocrPage renders into o.tempDir and deletes the PNG as soon as
          // tesseract is done with it.
          const ocrText = await ocrPage(file, sha256, pageNo, ocrCtx);
          return { ...page, source: sourceAfterOcr(plan.ocrReason), ocrText };
        } catch (err) {
          return { ...page, source: "failed", error: join(page.error, `ocr: ${toolMessage(err)}`) };
        }
      })
    );
    for (const page of pages) yield page;
  }
}

function join(a: string | null, b: string): string {
  return a ? `${a}; ${b}` : b;
}
