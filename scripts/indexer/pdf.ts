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

export interface WordBox {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PageBoxes {
  /** Page size in points, as pdftotext reports it. */
  width: number;
  height: number;
  words: WordBox[];
}

/** Where every word of the text layer sits on its page (pdftotext -bbox), one entry per page. */
export async function textBoxes(file: string, timeoutMs: number): Promise<PageBoxes[]> {
  const out = await runText("pdftotext", ["-bbox", "-enc", "UTF-8", file, "-"], { timeoutMs });
  const pages: PageBoxes[] = [];
  let current: PageBoxes | null = null;
  for (const line of out.split("\n")) {
    const page = line.match(/<page width="([\d.]+)" height="([\d.]+)"/);
    if (page) {
      current = { width: Number(page[1]), height: Number(page[2]), words: [] };
      pages.push(current);
      continue;
    }
    const word = line.match(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</);
    if (word && current) {
      current.words.push({ xMin: Number(word[1]), yMin: Number(word[2]), xMax: Number(word[3]), yMax: Number(word[4]), text: word[5] });
    }
  }
  return pages;
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
  timeoutMs: number,
  niceness = 0
): Promise<string> {
  const p = String(page);
  await run(
    "pdftoppm",
    ["-r", String(dpi), "-gray", "-png", "-singlefile", "-f", p, "-l", p, file, outBase],
    { timeoutMs, niceness }
  );
  const png = `${outBase}.png`;
  await fs.access(png);
  return png;
}

/**
 * Renders one page to `<outBase>.pgm` for OCR. An uncompressed greyscale image
 * takes a few milliseconds to write where a PNG takes about half a second at
 * 300 DPI, for the same pixels; tesseract must then be told the resolution
 * (--dpi), because a PGM doesn't carry it. The text it reads is identical.
 */
export async function renderForOcr(
  file: string,
  page: number,
  dpi: number,
  outBase: string,
  timeoutMs: number,
  niceness = 0
): Promise<string> {
  const p = String(page);
  await run("pdftoppm", ["-r", String(dpi), "-gray", "-singlefile", "-f", p, "-l", p, file, outBase], { timeoutMs, niceness });
  const pgm = `${outBase}.pgm`;
  await fs.access(pgm);
  return pgm;
}

/** Tesseract on one image, one thread (we parallelise across pages instead). */
export async function ocrImage(
  image: string,
  lang: string,
  timeoutMs: number,
  niceness = 0,
  /** The image's resolution, when it carries none (a PGM). */
  dpi?: number
): Promise<string> {
  return runText("tesseract", [image, "stdout", "-l", lang, "--psm", "3", ...(dpi ? ["--dpi", String(dpi)] : [])], {
    timeoutMs,
    niceness,
    // Tesseract otherwise starts one thread per core for each page; with
    // eight pages in flight that is 80 threads fighting over 10 cores.
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
  });
}

export interface OcrReading {
  text: string;
  /** Share of recognised words tesseract was under 60% sure of: high on pages in a script the language can't read. */
  lowConfidenceShare: number;
}

/**
 * Tesseract on one image like ocrImage, also reporting how sure it was of its
 * words. One pass writes both the text and the per-word confidences, so the
 * text is the same as ocrImage's.
 */
export async function ocrImageWithConfidence(
  image: string,
  lang: string,
  timeoutMs: number,
  niceness = 0,
  dpi?: number
): Promise<OcrReading> {
  const base = image.replace(/\.(png|pgm)$/i, "") + `-${lang.replace(/\W+/g, "_")}`;
  try {
    await run("tesseract", [image, base, "-l", lang, "--psm", "3", ...(dpi ? ["--dpi", String(dpi)] : []), "txt", "tsv"], {
      timeoutMs,
      niceness,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });
    const text = await fs.readFile(`${base}.txt`, "utf8");
    const tsv = (await fs.readFile(`${base}.tsv`, "utf8")).split("\n").slice(1);
    let words = 0;
    let low = 0;
    for (const line of tsv) {
      const c = line.split("\t");
      if (c.length < 12 || !c[11].trim()) continue;
      words++;
      if (Number(c[10]) < 60) low++;
    }
    return { text, lowConfidenceShare: words === 0 ? 0 : low / words };
  } finally {
    await fs.rm(`${base}.txt`, { force: true });
    await fs.rm(`${base}.tsv`, { force: true });
  }
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
