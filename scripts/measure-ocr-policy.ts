/**
 * npm run measure:ocr-policy -- <index db> <pdf folder>
 *
 * Judges the "OCR only the pages that need it" policy against a run that OCR'd
 * every page (the index produced by `bench:upload` with OCR_PAGES=all, which
 * stores both the text layer and the OCR reading of each page).
 *
 * A page "needs OCR" when its OCR reading contains at least MIN_KNOWN_MISSING
 * words (4+ letters) that never appear in that page's text layer but do appear
 * in some other page's layer (so they are real words, not OCR noise). That is
 * the same test measure-mixed.ts uses; it finds the pages whose visible text
 * the text layer lacks or breaks: lettering drawn as vector shapes, letter-
 * spaced words, garbled fonts.
 *
 * For each page it then runs the policy (planPage with ocrMode "smart", plus
 * the ink check that needs the PDF) and reports, against that label:
 *   caught  - needs OCR, policy OCRs it
 *   missed  - needs OCR, policy skips it (the risk; each is listed)
 *   spared  - does not need OCR, policy skips it (the saving)
 *   extra   - does not need OCR, policy OCRs it anyway (wasted work)
 */
import path from "node:path";
import Database from "better-sqlite3";
import { foldCase, loosen, normalizeText } from "../src/lib/search/normalize";
import { loadConfig } from "./indexer/config";
import { planPage } from "./indexer/classify";
import { imageCoverage, pdfInfo, textLayerAll } from "./indexer/pdf";
import { brokenWordJoins, uncoveredInkShare } from "./indexer/ink";
import { textBoxes } from "./indexer/pdf";

const MIN_KNOWN_MISSING = Number(process.env.MIN_KNOWN_MISSING ?? 3);

function words(text: string): Set<string> {
  const loose = loosen(foldCase(normalizeText(text)));
  return new Set(loose.split(" ").filter((w) => w.length >= 4 && /\p{L}/u.test(w)));
}

async function main() {
  const [indexPath, folder] = process.argv.slice(2);
  if (!indexPath || !folder) {
    console.error("usage: measure-ocr-policy <index db> <pdf folder>");
    process.exit(2);
  }
  const config = loadConfig();
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT d.filename, d.original_filename AS name, d.sha256, p.page_no AS pageNo, p.source,
              (SELECT body FROM texts t WHERE t.page_id = p.id AND t.kind = 'layer') AS layer,
              (SELECT body FROM texts t WHERE t.page_id = p.id AND t.kind = 'ocr') AS ocr
       FROM pages p JOIN documents d ON d.id = p.doc_id
       ORDER BY d.original_filename, p.page_no`
    )
    .all() as Array<{ filename: string; name: string; sha256: string; pageNo: number; source: string; layer: string | null; ocr: string | null }>;
  db.close();

  const pagesWithWord = new Map<string, number>();
  for (const r of rows) for (const w of words(r.layer ?? "")) pagesWithWord.set(w, (pagesWithWord.get(w) ?? 0) + 1);

  const byFile = new Map<string, typeof rows>();
  for (const r of rows) byFile.set(r.name, [...(byFile.get(r.name) ?? []), r]);

  const tally = { caught: 0, missed: 0, spared: 0, extra: 0 };
  const byReason: Record<string, { needs: number; extra: number }> = {};
  const missedList: string[] = [];
  const feats: Array<{ needs: boolean; ink: number; tight: number; noLayer: boolean }> = [];
  const inkNeeds: number[] = [];
  const inkOther: number[] = [];
  let ocrPages = 0;
  let pages = 0;

  for (const [name, pageRows] of byFile) {
    const file = path.join(folder, name);
    const info = await pdfInfo(file, config.pageTimeoutMs);
    const layers = (await textLayerAll(file, info.pageCount, config.pageTimeoutMs * 2)) ?? pageRows.map((r) => r.layer ?? "");
    const coverage = await imageCoverage(file, info.pageAreas, config.pageTimeoutMs);
    const ink = await uncoveredInkShare(file, info.pageCount, config.pageTimeoutMs);
    const tight = (await textBoxes(file, config.pageTimeoutMs * 2)).map((b) => brokenWordJoins(b));
    for (const r of pageRows) {
      pages++;
      const i = r.pageNo - 1;
      // Search is substring matching, so a word the layer holds inside another token ("8tenderer9")
      // is not missing; one split apart ("U nit") or absent is.
      const layerLoose = loosen(foldCase(normalizeText(r.layer ?? "")));
      const ocrWords = words(r.ocr ?? "");
      const knownMissing = [...ocrWords].filter((w) => !layerLoose.includes(w) && (pagesWithWord.get(w) ?? 0) >= 1);
      const needs = r.source === "ocr" || knownMissing.length >= MIN_KNOWN_MISSING;
      const plan = planPage(layers[i] ?? "", coverage[i] ?? 0, { ...config, ocrMode: "smart", uncoveredInk: ink[i] ?? 0, brokenJoins: tight[i] ?? 0 });
      const ocrs = plan.ocrReason !== null;
      if (ocrs) ocrPages++;
      (needs ? inkNeeds : inkOther).push(ink[i] ?? 0);
      feats.push({ needs, ink: ink[i] ?? 0, tight: tight[i] ?? 0, noLayer: r.source === "ocr" });
      const key = plan.ocrReason ?? "none";
      byReason[key] ??= { needs: 0, extra: 0 };
      if (needs && ocrs) tally.caught++;
      else if (needs && !ocrs) {
        tally.missed++;
        missedList.push(`${name.slice(0, 40)} p${r.pageNo}: ${knownMissing.length} known words missing e.g. ${knownMissing.slice(0, 6).join(", ")} (ink ${(100 * (ink[i] ?? 0)).toFixed(2)}%)`);
      } else if (!needs && !ocrs) tally.spared++;
      else tally.extra++;
      if (ocrs) byReason[key][needs ? "needs" : "extra"]++;
    }
  }

  console.log(`pages ${pages}; the policy OCRs ${ocrPages} (${((100 * ocrPages) / pages).toFixed(1)}%)`);
  console.log(`caught ${tally.caught}, missed ${tally.missed}, spared ${tally.spared}, extra ${tally.extra}`);
  console.log("OCR'd pages by reason (needs OCR / extra):", JSON.stringify(byReason));
  const q = (xs: number[], f: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(f * (xs.length - 1))] : 0);
  const fmt = (xs: number[]) => [0.1, 0.5, 0.75, 0.9, 0.99].map((f) => (100 * q(xs, f)).toFixed(2) + "%").join(" / ");
  console.log(`uncovered ink share p10/p50/p75/p90/p99  needs-OCR: ${fmt(inkNeeds)}  others: ${fmt(inkOther)}`);
  const rest = feats.filter((f) => !f.noLayer);
  console.log(`pages with a layer: ${rest.length}, of which need OCR: ${rest.filter((f) => f.needs).length}`);
  for (const t of [1, 2, 3, 4, 6, 10, 20]) {
    const hit = rest.filter((f) => f.tight >= t);
    console.log(`  broken word joins >= ${t}: flags ${hit.length} pages, ${hit.filter((f) => f.needs).length} of them needing OCR`);
  }
  for (const t of [0.002, 0.004, 0.006, 0.01, 0.02, 0.04]) {
    const hit = rest.filter((f) => f.ink >= t);
    console.log(`  uncovered ink >= ${(t * 100).toFixed(1)}%: flags ${hit.length} pages, ${hit.filter((f) => f.needs).length} needing OCR`);
  }
  for (const m of missedList) console.log("  MISSED " + m);
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
