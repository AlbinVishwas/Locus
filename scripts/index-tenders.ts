/**
 * npm run index [-- --force]
 *
 * Reads every PDF in TENDERS_DIR (default data/tenders), updates the search
 * index at SEARCH_INDEX_PATH (default data/index/search.db), then prints the
 * index report and saves it next to the index as report.txt / report.json.
 *
 * Exit code: 0 if every page was read, 2 if any page or document failed
 * (they are indexed as "failed" and listed in the report), 1 if the run
 * itself broke or the completeness check found a document with missing rows.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./indexer/config";
import { runIndexer } from "./indexer/indexer";
import { buildReport, formatReport } from "./indexer/report";

async function main() {
  const force = process.argv.includes("--force");
  const config = loadConfig();

  if (!fs.existsSync(config.tendersDir)) {
    console.error(`No such folder: ${config.tendersDir}. Put the PDFs there or set TENDERS_DIR.`);
    process.exit(1);
  }

  const summary = await runIndexer(config, { force });
  const report = buildReport(config.indexPath);
  const text = formatReport(report);

  const dir = path.dirname(config.indexPath);
  fs.writeFileSync(path.join(dir, "report.txt"), text + "\n");
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ summary, report }, null, 2));

  console.log(text);
  console.log("");
  console.log(
    `Run: ${summary.added.length} added, ${summary.updated.length} updated, ` +
      `${summary.renamed.length} renamed, ${summary.removed.length} removed, ` +
      `${summary.unchanged.length} unchanged; OCR ${summary.ocrRun} pages run, ` +
      `${summary.ocrCached} from cache; ${summary.seconds.toFixed(1)} s`
  );
  for (const r of summary.renamed) console.log(`  renamed: ${r.from} -> ${r.to}`);
  for (const r of summary.removed) console.log(`  removed: ${r}`);

  if (report.missingPages.length > 0) process.exit(1);
  if (report.totals.failed > 0 || report.documents.some((d) => d.error)) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
