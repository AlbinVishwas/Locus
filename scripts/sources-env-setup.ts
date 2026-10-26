/**
 * Fixtures for the Sources end-to-end checks and the screenshots script:
 *
 *   node --import tsx scripts/sources-env-setup.ts <dir>
 *
 * Under <dir> it makes `roots/` (the one allowed location), with a folder of
 * small text PDFs ("Tenders 2026"), a second folder of PDFs listed by a
 * SQLite database (`records.sqlite`), and `drive-tree.json`, the folder tree
 * the mock Google Drive serves (scripts/mock-drive.ts). Everything is made up
 * and generated here: no client document is involved. Delete <dir> afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { writeFixturePdf } from "./indexer/fixtures";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: sources-env-setup.ts <dir>");
  process.exit(1);
}

const work = path.join(dir, "work");
fs.mkdirSync(work, { recursive: true });

async function pdf(file: string, pages: string[][]): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFixturePdf(file, pages.map((lines) => ({ lines })), { workDir: work });
}

async function main() {
  const roots = path.join(dir, "roots");

  // Source 1: a folder. "turbine rotor" is only here; "indemnity" is here and in the database source.
  const tenders = path.join(roots, "Tenders 2026");
  const names = ["Trichy/notice-001", "Trichy/notice-002", "Trichy/spec-003", "Mumbai/notice-004", "Mumbai/spec-005", "Mumbai/annex-006", "spec-007", "annex-008"];
  for (const [i, n] of names.entries()) {
    await pdf(path.join(tenders, `${n}.pdf`), [
      [`Tender notice ${i + 1}`, "The turbine rotor clearance shall be verified before dispatch."],
      [`Section ${i + 1}.2`, "The supplier shall provide an indemnity bond for the full contract value.", "Payment terms: net 45 days."],
      [`Annexure ${i + 1}`, "Bid security of two percent is payable by demand draft."],
    ]);
  }

  // Source 2: a SQLite database listing PDFs that sit in another folder.
  const records = path.join(roots, "Records");
  const rows: Array<[number, string, string]> = [];
  for (let i = 1; i <= 4; i++) {
    const file = path.join(records, `po-${i}.pdf`);
    await pdf(file, [[`Purchase order ${i}`, "Seller indemnity applies to all deliveries.", "The gearbox warranty period is twenty four months."]]);
    rows.push([i, `po-${i}.pdf`, file]);
  }
  const db = new Database(path.join(roots, "records.sqlite"));
  db.exec("CREATE TABLE records (rid INTEGER PRIMARY KEY, title TEXT, changed TEXT, location TEXT)");
  const ins = db.prepare("INSERT INTO records VALUES (?, ?, ?, ?)");
  for (const [id, title, file] of rows) ins.run(id, title, "2026-03-0" + id + "T09:00:00Z", file);
  db.close();

  // Source 3: what the mock Google Drive serves.
  const drivePdf = async (name: string, lines: string[]) => {
    const f = path.join(work, name);
    await pdf(f, [lines]);
    return fs.readFileSync(f).toString("base64");
  };
  const folderId = "1MockDriveFolderIdForLocusTests";
  const tree = [
    { id: folderId, name: "BHEL tenders", mimeType: "application/vnd.google-apps.folder", parent: null },
    { id: "g1", name: "boiler-spec.pdf", parent: folderId, content: await drivePdf("g1.pdf", ["Boiler feed pump", "The pump casing is made of cast steel.", "Seller indemnity is limited to direct loss."]) },
    { id: "g2", name: "valve-list.pdf", parent: folderId, content: await drivePdf("g2.pdf", ["Valve list", "Gate valves, class 300."]) },
    { id: "gx", name: "notes", mimeType: "application/vnd.google-apps.document", parent: folderId },
  ];
  fs.writeFileSync(path.join(dir, "drive-tree.json"), JSON.stringify({ folderId, tree }));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  console.log(JSON.stringify({ roots, folderId }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
