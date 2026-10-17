import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { run, runText } from "./exec";

/**
 * Thin wrappers around poppler's command-line tools (brew install poppler).
 * Each returns plain data; deciding what to do with a page is classify.ts's
 * job.
 */

export interface PdfInfo {
  pageCount: number;
  /** Page area in square inches, index 0 = page 1. */
  pageAreas: number[];
}

export async function pdfInfo(file: string, timeoutMs: number): Promise<PdfInfo> {
  // -f/-l make pdfinfo print every page's size, not just page 1's.
  const out = await runText("pdfinfo", ["-f", "1", "-l", "1000000", file], { timeoutMs });
  const pagesLine = out.match(/^Pages:\s+(\d+)/m);
  if (!pagesLine) throw new Error("pdfinfo did not report a page count");
  const pageCount = Number(pagesLine[1]);

  const pageAreas = new Array<number>(pageCount).fill(0);
  for (const m of out.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)) {
    const index = Number(m[1]) - 1;
    if (index >= 0 && index < pageCount) {
      pageAreas[index] = (Number(m[2]) / 72) * (Number(m[3]) / 72);
    }
  }
  return { pageCount, pageAreas };
}

/**
 * The text layer of every page in one pdftotext call. pdftotext ends each page
 * with a form feed (\f), so splitting on it gives one entry per page. If the
 * count doesn't come out exactly right, returns null and the caller falls
 * back to one call per page — a page boundary is never guessed.
 */
export async function textLayerAll(
  file: string,
  pageCount: number,
  timeoutMs: number
): Promise<string[] | null> {
  const out = await runText("pdftotext", ["-enc", "UTF-8", file, "-"], { timeoutMs });
  const parts = out.split("\f");
  // n pages produce n form feeds, so n + 1 parts with an empty tail.
  if (parts.length !== pageCount + 1 || parts[pageCount].trim() !== "") return null;
  return parts.slice(0, pageCount);
}

export async function textLayerPage(file: string, page: number, timeoutMs: number): Promise<string> {
  const p = String(page);
  const out = await runText("pdftotext", ["-enc", "UTF-8", "-f", p, "-l", p, file, "-"], {
    timeoutMs,
  });
  return out.replace(/\f$/, "");
}

/**
 * Share of each page covered by embedded images (0..1), from `pdfimages
 * -list`. Each listed image reports its pixel size and the resolution it is
 * drawn at, so pixels / resolution = its printed size in inches. Images drawn
 * in overlapping strips can add up past the page area; the result is capped
 * at 1. Soft masks are skipped because they duplicate the image they mask.
 */
export async function imageCoverage(
  file: string,
  pageAreas: number[],
  timeoutMs: number
): Promise<number[]> {
  const out = await runText("pdfimages", ["-list", file], { timeoutMs });
  const covered = new Array<number>(pageAreas.length).fill(0);

  for (const line of out.split("\n").slice(2)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 14) continue;
    const [pageStr, , type, widthStr, heightStr] = c;
    if (type !== "image" && type !== "stencil") continue;
    const xPpi = Number(c[12]);
    const yPpi = Number(c[13]);
    const index = Number(pageStr) - 1;
    if (!(xPpi > 0 && yPpi > 0) || index < 0 || index >= pageAreas.length) continue;
    covered[index] += (Number(widthStr) / xPpi) * (Number(heightStr) / yPpi);
  }

  return covered.map((area, i) => (pageAreas[i] > 0 ? Math.min(1, area / pageAreas[i]) : 0));
}

/** A greyscale render of one page as a binary PGM image, streamed via stdout. */
export async function renderGray(
  file: string,
  page: number,
  dpi: number,
  timeoutMs: number
): Promise<Buffer> {
  const p = String(page);
  return run("pdftoppm", ["-r", String(dpi), "-gray", "-f", p, "-l", p, file], { timeoutMs });
}

/** Renders one page to `<outBase>.png` for OCR and returns that path. */
export async function renderPng(
  file: string,
  page: number,
  dpi: number,
  outBase: string,
  timeoutMs: number
): Promise<string> {
  const p = String(page);
  await run(
    "pdftoppm",
    ["-r", String(dpi), "-gray", "-png", "-singlefile", "-f", p, "-l", p, file, outBase],
    { timeoutMs }
  );
  const png = `${outBase}.png`;
  await fs.access(png);
  return png;
}

/** Tesseract on one image, one thread (we parallelise across pages instead). */
export async function ocrImage(
  image: string,
  lang: string,
  timeoutMs: number
): Promise<string> {
  return runText("tesseract", [image, "stdout", "-l", lang, "--psm", "3"], {
    timeoutMs,
    // Tesseract otherwise starts one thread per core for each page; with
    // eight pages in flight that is 80 threads fighting over 10 cores.
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
  });
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function listPdfs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ".pdf")
    .map((e) => e.name)
    .sort();
}
