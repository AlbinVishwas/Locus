import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFString, StandardFonts } from "pdf-lib";

/**
 * Builds small synthetic PDFs for the pipeline tests. Nothing here comes from
 * a client document, so the fixtures are safe to generate anywhere.
 *
 * An "image page" is made the way a scanner would: the words are drawn into a
 * throwaway PDF, rendered to a PNG with poppler, and that PNG is placed on a
 * new page. The result has visible text but no text layer at all — exactly
 * what the OCR path exists for.
 */

export interface FixturePage {
  /** Typed text lines (a real text layer). */
  lines?: string[];
  /** Words that appear only inside an image (no text layer for them). */
  imageWords?: string;
  /** Fraction of the page height the image takes (default: full page). */
  imageHeight?: number;
}

const WIDTH = 595; // A4 in points
const HEIGHT = 842;

async function renderWordsToPng(words: string, workDir: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([WIDTH, 300]);
  page.drawText(words, { x: 40, y: 140, size: 34, font });
  const pdfPath = path.join(workDir, `words-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  fs.writeFileSync(pdfPath, await doc.save());
  const base = pdfPath.replace(/\.pdf$/, "");
  execFileSync("pdftoppm", ["-r", "150", "-png", "-singlefile", pdfPath, base]);
  const png = fs.readFileSync(`${base}.png`);
  fs.rmSync(pdfPath);
  fs.rmSync(`${base}.png`);
  return png;
}

export async function writeFixturePdf(
  file: string,
  pages: FixturePage[],
  options: { labels?: boolean; workDir: string }
): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of pages) {
    const page = doc.addPage([WIDTH, HEIGHT]);
    let y = HEIGHT - 60;
    for (const line of spec.lines ?? []) {
      page.drawText(line, { x: 50, y, size: 12, font });
      y -= 18;
    }
    if (spec.imageWords) {
      const png = await doc.embedPng(await renderWordsToPng(spec.imageWords, options.workDir));
      const h = HEIGHT * (spec.imageHeight ?? 1);
      page.drawImage(png, { x: 0, y: 0, width: WIDTH, height: h });
    }
  }

  if (options.labels) {
    // Pages 1-2 are "i", "ii"; from page 3 on, "A-1", "A-2", ...
    doc.catalog.set(
      doc.context.obj("PageLabels"),
      doc.context.obj({
        Nums: [0, { S: "r" }, 2, { S: "D", P: PDFString.of("A-"), St: 1 }],
      })
    );
  }

  fs.writeFileSync(file, await doc.save());
}
