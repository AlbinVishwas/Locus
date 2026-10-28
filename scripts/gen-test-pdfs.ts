/**
 * npm run gen:test-pdfs -- <folder> [--files N] [--seed S] [--scanned K]
 *
 * Generates a folder of synthetic PDFs for tests, benchmarks and the fresh-clone check. Nothing here comes from a
 * client document. A manifest (manifest.json beside the files) lists every file with the unique marker word planted
 * on a known page, so a search can be checked end to end: "marker <n>" must be found in <file> on page <p>.
 *
 * The mix: mostly typed PDFs of 3-40 pages in a few sub-folders, some scanned PDFs (a picture of the words, no text
 * layer: they need OCR), a few mixed ones, and one corrupt file.
 */
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { execFileSync } from "node:child_process";
import type { FixturePage } from "./indexer/fixtures";
import { mulberry32 } from "../src/lib/library/pipeline";

export interface GeneratedFile {
  path: string;
  kind: "text" | "scanned" | "mixed" | "corrupt";
  pages: number;
  /** A word that appears on exactly one page of exactly this file. */
  marker: string | null;
  markerPage: number | null;
  bytes: number;
}

export interface GenerateOptions {
  files?: number;
  scanned?: number;
  mixed?: number;
  seed?: number;
  /** Where scratch images go (scanned pages are rendered through poppler). */
  workDir?: string;
}

const SYLLABLES = ["ka", "ro", "ti", "mel", "dor", "van", "sun", "lex", "pra", "gon", "bel", "tur", "mi", "sha", "ner", "fo", "quil", "zan", "ode", "ris", "hal", "pun", "cor", "ve"];

function makeVocabulary(rng: () => number, size: number): string[] {
  const words = new Set<string>();
  while (words.size < size) {
    const n = 2 + Math.floor(rng() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
    words.add(w);
  }
  return [...words];
}

const REAL_WORDS = ["lighthouse", "thunderstorm", "marketplace", "waterfall", "blueprint", "harvest", "telescope", "mountain", "orchestra", "passport", "calendar", "umbrella", "lantern", "compass", "treasure", "festival", "library", "violin", "bicycle", "pyramid", "cathedral", "elephant", "notebook", "airplane", "carpenter", "diamond", "envelope", "fountain", "gardener", "hospital"];

/** 0 -> "a", 25 -> "z", 26 -> "ba"... */
function letters(n: number): string {
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  } while (n > 0);
  return out;
}

function line(rng: () => number, vocab: string[], words = 9): string {
  return Array.from({ length: words }, () => vocab[Math.floor(rng() * vocab.length)]).join(" ");
}


/**
 * Like the test fixtures' scanned page (the words drawn into a picture, no text layer, so OCR must read them) but at
 * 300 dpi and a larger size: the OCR settings Locus really uses, and no misread letters to confuse a check.
 */
async function writePdf(file: string, pages: FixturePage[], workDir: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage([595, 842]);
    let y = 842 - 60;
    for (const text of spec.lines ?? []) {
      page.drawText(text, { x: 50, y, size: 12, font });
      y -= 18;
    }
    if (spec.imageWords) {
      const words = await PDFDocument.create();
      const bold = await words.embedFont(StandardFonts.HelveticaBold);
      const wp = words.addPage([595, 300]);
      wp.drawText(spec.imageWords, { x: 40, y: 130, size: 48, font: bold });
      const base = path.join(workDir, `w-${process.pid}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(`${base}.pdf`, await words.save());
      execFileSync("pdftoppm", ["-r", "300", "-png", "-singlefile", `${base}.pdf`, base]);
      const png = await doc.embedPng(fs.readFileSync(`${base}.png`));
      fs.rmSync(`${base}.pdf`);
      fs.rmSync(`${base}.png`);
      page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 * (spec.imageHeight ?? 1) });
    }
  }
  fs.writeFileSync(file, await doc.save());
}

async function typedPdf(file: string, pages: number, rng: () => number, vocab: string[], marker: string, markerPage: number): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([595, 842]);
    let y = 800;
    for (let i = 0; i < 38; i++) {
      page.drawText(line(rng, vocab), { x: 40, y, size: 11, font });
      y -= 19;
    }
    if (p === markerPage) page.drawText(`Reference ${marker} applies here`, { x: 40, y: 40, size: 11, font });
  }
  fs.writeFileSync(file, await doc.save());
}

export async function generateTestPdfs(dir: string, options: GenerateOptions = {}): Promise<GeneratedFile[]> {
  const total = options.files ?? 60;
  const scanned = options.scanned ?? Math.max(1, Math.round(total * 0.12));
  const mixed = options.mixed ?? Math.max(1, Math.round(total * 0.05));
  const rng = mulberry32(options.seed ?? 20261028);
  const vocab = makeVocabulary(rng, 4000);
  const work = options.workDir ?? path.join(dir, ".gen-work");
  fs.mkdirSync(work, { recursive: true });
  const folders = ["", "tenders/2024", "tenders/2025", "contracts", "annexures/civil"];
  const out: GeneratedFile[] = [];
  for (let i = 0; i < total; i++) {
    const kind: GeneratedFile["kind"] = i < scanned ? "scanned" : i < scanned + mixed ? "mixed" : "text";
    const sub = folders[i % folders.length];
    const name = `${kind === "text" ? "doc" : kind}-${String(i).padStart(4, "0")}.pdf`;
    const file = path.join(dir, sub, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Typed pages can carry any made-up word; a scanned page has to be read by OCR, which reads real words reliably and invented ones badly.
    const marker = kind === "scanned" ? REAL_WORDS[i % REAL_WORDS.length] : `zorbaflux${letters(i)}`;
    let pages: number;
    let markerPage: number;
    if (kind === "scanned") {
      pages = 2 + Math.floor(rng() * 3);
      markerPage = 1 + Math.floor(rng() * pages);
      await writePdf(
        file,
        Array.from({ length: pages }, (_, p) => ({ imageWords: p + 1 === markerPage ? `Reference ${marker}` : `Scanned page ${p + 1}` })),
        work
      );
    } else if (kind === "mixed") {
      pages = 3 + Math.floor(rng() * 3);
      markerPage = 1 + 2 * Math.floor(rng() * Math.ceil(pages / 2)); // the typed pages are the odd-numbered ones
      await writePdf(
        file,
        Array.from({ length: pages }, (_, p) => (p % 2 === 0 ? { lines: [line(rng, vocab), line(rng, vocab), p + 1 === markerPage ? `Reference ${marker} typed` : line(rng, vocab)] } : { imageWords: `Annexure page ${p + 1}`, imageHeight: 0.5 })),
        work
      );
    } else {
      pages = 3 + Math.floor(rng() * 38);
      markerPage = 1 + Math.floor(rng() * pages);
      await typedPdf(file, pages, rng, vocab, marker, markerPage);
    }
    // Files on a server are old: not "still being copied" (see LIBRARY_SETTLE_SECONDS).
    const aged = new Date(Date.now() - 24 * 3600_000);
    fs.utimesSync(file, aged, aged);
    out.push({ path: path.relative(dir, file).split(path.sep).join("/"), kind, pages, marker, markerPage, bytes: fs.statSync(file).size });
  }
  // One file that isn't a PDF at all, to see the failure listed and skipped.
  const bad = path.join(dir, "contracts", "corrupt-0001.pdf");
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, "%PDF-1.4\nthis is not really a pdf\n");
  fs.utimesSync(bad, new Date(Date.now() - 24 * 3600_000), new Date(Date.now() - 24 * 3600_000));
  out.push({ path: "contracts/corrupt-0001.pdf", kind: "corrupt", pages: 0, marker: null, markerPage: null, bytes: fs.statSync(bad).size });
  fs.rmSync(work, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ seed: options.seed ?? 20261028, files: out }, null, 2));
  return out;
}

if (process.argv[1] && /gen-test-pdfs\.[tj]s$/.test(process.argv[1])) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const dir = process.argv[2];
  if (!dir || dir.startsWith("--")) {
    console.error("usage: gen-test-pdfs <folder> [--files N] [--scanned K] [--seed S]");
    process.exit(2);
  }
  generateTestPdfs(path.resolve(dir), { files: arg("files") ? Number(arg("files")) : undefined, scanned: arg("scanned") ? Number(arg("scanned")) : undefined, seed: arg("seed") ? Number(arg("seed")) : undefined }).then(
    (files) => {
      const bytes = files.reduce((s, f) => s + f.bytes, 0);
      console.log(`Generated ${files.length} PDFs (${(bytes / 1e6).toFixed(1)} MB) in ${dir}`);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
