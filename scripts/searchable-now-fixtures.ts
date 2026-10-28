/**
 * Fixtures for the "Searchable now" end-to-end check:
 *
 *   node --import tsx scripts/searchable-now-fixtures.ts <dir>
 *
 * `Mixed/` holds two typed PDFs (text layer, searchable the moment they are indexed) and one
 * PDF of 28 scanned pages, each with its own words, so reading them takes a while and the
 * "improving N scanned pages" state can be seen. All made up and generated here.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFixturePdf } from "./indexer/fixtures";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: searchable-now-fixtures.ts <dir>");
  process.exit(1);
}
const work = path.join(dir, "work");
fs.mkdirSync(work, { recursive: true });
const METALS = ["Zircon", "Quartz", "Cobalt", "Indium", "Nickel", "Silver", "Copper", "Tin", "Lead", "Zinc", "Brass", "Steel", "Gold", "Iron"];
const PARTS = ["valve", "flange", "gasket", "washer", "coupling", "bracket", "nozzle", "bearing", "socket", "spindle", "sleeve", "terminal", "collar", "bolt"];
// 28 scanned pages, each with its own pair of words ("Zircon valve" ... ).
const SCAN_WORDS = Array.from({ length: 28 }, (_, i) => `${METALS[i % METALS.length]} ${PARTS[(i * 3) % PARTS.length]}`);

async function main() {
  const pack = path.join(dir, "Mixed");
  fs.mkdirSync(pack, { recursive: true });
  await writeFixturePdf(path.join(pack, "typed-one.pdf"), [{ lines: ["Typed tender one", "TYPED-ALPHA-PHRASE appears on this page.", "The impeller clearance shall be verified."] }, { lines: ["Second page", "Warranty period is twelve months."] }], { workDir: work });
  await writeFixturePdf(path.join(pack, "typed-two.pdf"), [{ lines: ["Typed tender two", "TYPED-BETA-PHRASE appears here."] }], { workDir: work });
  await writeFixturePdf(path.join(pack, "scans.pdf"), SCAN_WORDS.map((w) => ({ lines: ["Scanned annexure"], imageWords: w, imageHeight: 0.5 })), { workDir: work });
  console.log(JSON.stringify({ pack }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
