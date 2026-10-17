/**
 * npm run measure:mixed
 *
 * One-off audit of the mixed-page rule. The indexer only OCRs a page that has
 * a text layer when images cover >= MIXED_IMAGE_COVERAGE of it. This script
 * OCRs every *other* text page too and compares: if OCR sees many words that
 * the text layer doesn't contain, the page has visible text that only exists
 * as an image or vector drawing — content the index would miss.
 *
 * Comparison: distinct words of 4+ characters containing a letter, in loose
 * form (lowercased, punctuation stripped). A page is reported as a likely
 * miss when OCR finds at least MIN_MISSING such words absent from the text
 * layer AND they are at least MIN_FRACTION of OCR's distinct words. Both
 * conditions together filter out ordinary OCR misreads, which produce a few
 * stray non-words on almost every page. The top pages are printed with
 * sample words so a person can judge.
 *
 * A second, stricter signal counts only "known" missing words: words that
 * occur in the text layer of some other page of the collection. OCR garbage
 * ("cccceeee") never qualifies, so even a few known words missing from a
 * page means real visible text the text layer lacks. A page with
 * MIN_KNOWN_MISSING or more is listed.
 *
 * Also counted: letter-spaced text layers ("BH ARAT H EAVY"), where the PDF
 * places letters individually and the extracted words come out broken. A
 * phrase search can't match those words in the text layer at all.
 *
 * OCR results go into the same cache the indexer uses, so this costs real
 * OCR time once (about 5 minutes for ~800 pages on 8 cores).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { foldCase, loosen, normalizeText } from "../src/lib/search/normalize";
import { loadConfig } from "./indexer/config";
import { createLimiter } from "./indexer/exec";
import { ocrPage, type ExtractContext } from "./indexer/extract";
import { OcrCache } from "./indexer/ocrCache";

const MIN_MISSING = 15;
const MIN_FRACTION = 0.2;
const MIN_KNOWN_MISSING = 3;
const LETTER_SPACED_SHARE = 0.25;

/** Share of alphabetic tokens that are 1-2 letters long ("BH ARAT" -> high). */
function shortTokenShare(text: string): number {
  const tokens = loosen(foldCase(normalizeText(text))).split(" ").filter((t) => /^\p{L}+$/u.test(t));
  if (tokens.length < 20) return 0;
  return tokens.filter((t) => t.length <= 2 && !["a", "i", "of", "to", "in", "on", "or", "by", "an", "as", "at", "be", "is", "it", "no", "if", "we", "do", "up", "so", "mm", "cm", "kg", "rs", "nos"].includes(t)).length / tokens.length;
}

function words(text: string): Set<string> {
  const loose = loosen(foldCase(normalizeText(text)));
  return new Set(loose.split(" ").filter((w) => w.length >= 4 && /\p{L}/u.test(w)));
}

async function main() {
  const config = loadConfig();
  const db = new Database(config.indexPath, { readonly: true, fileMustExist: true });
  const pages = db
    .prepare(
      `SELECT d.filename, d.sha256, p.page_no AS pageNo, t.body
       FROM pages p
       JOIN documents d ON d.id = p.doc_id
       JOIN texts t ON t.page_id = p.id AND t.kind = 'layer'
       WHERE p.source = 'text'
       ORDER BY d.filename, p.page_no`
    )
    .all() as Array<{ filename: string; sha256: string; pageNo: number; body: string }>;
  db.close();

  const ocrCache = new OcrCache(config.ocrCachePath);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tender-measure-"));
  const ctx: ExtractContext = {
    config,
    limit: createLimiter(config.concurrency),
    ocrCache,
    tempDir,
    log: (m) => console.error(m),
    stats: { ocrRun: 0, ocrCached: 0 },
  };

  // Vocabulary of every text layer in the collection (all sources, not just
  // the pages being checked), counting how many pages each word is on.
  const vocabDb = new Database(config.indexPath, { readonly: true });
  const pagesWithWord = new Map<string, number>();
  for (const body of vocabDb.prepare("SELECT body FROM texts WHERE kind = 'layer'").pluck().all() as string[]) {
    for (const w of words(body)) pagesWithWord.set(w, (pagesWithWord.get(w) ?? 0) + 1);
  }
  vocabDb.close();

  console.error(`OCR'ing ${pages.length} text-only pages (cached pages are reused)...`);
  const started = Date.now();
  let done = 0;
  const results = await Promise.all(
    pages.map(async (p) => {
      const file = path.join(config.tendersDir, p.filename);
      let ocr = "";
      let error: string | null = null;
      try {
        ocr = await ocrPage(file, p.sha256, p.pageNo, ctx);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (++done % 100 === 0) console.error(`  ${done}/${pages.length}`);
      const layerWords = words(p.body);
      const ocrWords = words(ocr);
      const missing = [...ocrWords].filter((w) => !layerWords.has(w));
      const knownMissing = missing.filter((w) => (pagesWithWord.get(w) ?? 0) >= 1);
      return {
        filename: p.filename,
        pageNo: p.pageNo,
        knownMissing,
        letterSpaced: shortTokenShare(p.body) >= LETTER_SPACED_SHARE,
        ocrWords: ocrWords.size,
        missing,
        fraction: ocrWords.size ? missing.length / ocrWords.size : 0,
        error,
      };
    })
  );
  ocrCache.close();
  await fsp.rm(tempDir, { recursive: true, force: true });

  const flagged = results.filter((r) => r.missing.length >= MIN_MISSING && r.fraction >= MIN_FRACTION);
  const errors = results.filter((r) => r.error);
  const fractions = results.map((r) => r.fraction).sort((a, b) => a - b);
  const pct = (q: number) => (fractions[Math.floor(q * (fractions.length - 1))] * 100).toFixed(1);

  const lines: string[] = [];
  lines.push("MIXED-PAGE MEASUREMENT");
  lines.push(`text-only pages checked: ${results.length}  (OCR run ${ctx.stats.ocrRun}, cached ${ctx.stats.ocrCached}, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  lines.push(`OCR errors: ${errors.length}`);
  lines.push(`share of OCR words missing from text layer: median ${pct(0.5)}%, p90 ${pct(0.9)}%, p99 ${pct(0.99)}%, max ${pct(1)}%`);
  lines.push(`likely misses (>= ${MIN_MISSING} missing words AND >= ${MIN_FRACTION * 100}%): ${flagged.length}`);
  for (const r of flagged) {
    lines.push(`  ${r.filename} p${r.pageNo}: ${r.missing.length}/${r.ocrWords} missing (${(r.fraction * 100).toFixed(0)}%) e.g. ${r.missing.slice(0, 10).join(", ")}`);
  }
  const known = results.filter((r) => r.knownMissing.length >= MIN_KNOWN_MISSING);
  lines.push(`pages missing >= ${MIN_KNOWN_MISSING} known words (words found in other pages' text layers): ${known.length}`);
  for (const r of known.sort((a, b) => b.knownMissing.length - a.knownMissing.length)) {
    lines.push(`  ${r.filename.slice(0, 40)} p${r.pageNo}: ${r.knownMissing.length} known words missing, e.g. ${r.knownMissing.slice(0, 10).join(", ")}`);
  }
  const spaced = results.filter((r) => r.letterSpaced);
  const spacedByDoc = new Map<string, number[]>();
  for (const r of spaced) spacedByDoc.set(r.filename, [...(spacedByDoc.get(r.filename) ?? []), r.pageNo]);
  lines.push(`letter-spaced text layers (>= ${LETTER_SPACED_SHARE * 100}% of words are 1-2 letter fragments): ${spaced.length}`);
  for (const [f, ps] of spacedByDoc) lines.push(`  ${f}: ${ps.length} pages (${ps.slice(0, 12).join(", ")}${ps.length > 12 ? ", ..." : ""})`);
  lines.push("");
  lines.push("Top 15 pages by missing-word count (for judging by eye):");
  for (const r of [...results].sort((a, b) => b.missing.length - a.missing.length).slice(0, 15)) {
    lines.push(`  ${r.filename.slice(0, 40)} p${r.pageNo}: ${r.missing.length}/${r.ocrWords} (${(r.fraction * 100).toFixed(0)}%) e.g. ${r.missing.slice(0, 8).join(", ")}`);
  }
  for (const r of errors) lines.push(`  OCR ERROR ${r.filename} p${r.pageNo}: ${r.error}`);

  const text = lines.join("\n");
  fs.writeFileSync(path.join(path.dirname(config.indexPath), "mixed-measurement.txt"), text + "\n");
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
