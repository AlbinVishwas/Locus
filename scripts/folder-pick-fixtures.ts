/**
 * Fixtures for the folder-pick end-to-end checks:
 *
 *   node --import tsx scripts/folder-pick-fixtures.ts <dir>
 *
 * Under <dir>: `Tender Pack/` (what gets picked: two tender PDFs, one with a scanned
 * page, one PDF in a subfolder, plus a .txt and a .jpg that must be skipped),
 * `outside/control.pdf` (the same phrase, outside the folder), `Crowded/` (five PDFs,
 * over a four-file limit) and `Oversize/` (one PDF over a small size limit). All made
 * up and generated here. Delete <dir> afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { writeFixturePdf } from "./indexer/fixtures";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: folder-pick-fixtures.ts <dir>");
  process.exit(1);
}
const work = path.join(dir, "work");
fs.mkdirSync(work, { recursive: true });
const PHRASE = "LOCUS-CONTROL-PHRASE";

async function pdf(file: string, pages: Array<{ lines?: string[]; imageWords?: string }>) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFixturePdf(file, pages, { workDir: work });
}

async function main() {
  const pack = path.join(dir, "Tender Pack");
  await pdf(path.join(pack, "tender-a.pdf"), [
    { lines: ["Tender notice A", `Reference ${PHRASE} appears in this tender.`, "The turbine rotor clearance shall be verified."] },
    { lines: ["Section A.2", "The supplier shall provide an indemnity bond."] },
  ]);
  await pdf(path.join(pack, "tender-b-scanned.pdf"), [
    { lines: ["Tender notice B", "Boiler feed pump specification."] },
    { imageWords: "Silicone gasket seating" },
  ]);
  await pdf(path.join(pack, "Annex", "annex-c.pdf"), [{ lines: ["Annexure C", "ANNEX-UNIQUE-WORDS describe the bid security."] }]);
  fs.writeFileSync(path.join(pack, "notes.txt"), "not a pdf\n");
  fs.writeFileSync(path.join(pack, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));

  await pdf(path.join(dir, "outside", "control.pdf"), [{ lines: ["An unrelated document", `This one also has ${PHRASE} but sits outside the folder.`] }]);

  for (let i = 1; i <= 5; i++) await pdf(path.join(dir, "Crowded", `doc-${i}.pdf`), [{ lines: [`Crowded document ${i}`] }]);

  const big = path.join(dir, "Oversize", "huge.pdf");
  await pdf(big, [{ lines: ["A document that is too big"] }]);
  fs.appendFileSync(big, Buffer.alloc(700_000, 32));
  console.log(JSON.stringify({ pack }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
