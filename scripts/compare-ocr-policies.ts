/**
 * npm run compare:ocr -- <old index db> <new index db> [phrases] [seed]
 *
 * Compares what search finds in two indexes of the same documents: the old one
 * (every page OCR'd in English+Hindi) and the new one (smart policy). Phrases
 * are real runs of 1-4 words taken from random pages of the OLD index, so
 * anything the new setting stopped finding shows up. Prints every phrase for
 * which the new index returns fewer (document, page) hits, with why; then the
 * known-hard checks and the Hindi pages.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { foldCase, loosen, normalizeText } from "../src/lib/search/normalize";
import { loadCorpus, seededRandom, viaIndex } from "./indexer/oracle";

const [oldPath, newPath, countArg, seedArg] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("usage: compare-ocr-policies <old index db> <new index db> [phrases] [seed]");
  process.exit(2);
}
const count = Number(countArg ?? 50);
const seed = Number(seedArg ?? 20261027);
const oldDb = new Database(oldPath, { readonly: true, fileMustExist: true });
const newDb = new Database(newPath, { readonly: true, fileMustExist: true });

const strip = (key: string) => key.replace(/^\d+:/, "");
function hits(db: Database.Database, phrase: string, mode: "exact" | "loose") {
  return new Set([...viaIndex(db, phrase, mode).pages].map(strip));
}
const short = (k: string) => k.replace(/-2026-\d\d-\d\d-[\d_]+\.pdf/, "");

// The pages of the old index with their text, to draw phrases from.
const pages = oldDb
  .prepare(
    `SELECT COALESCE(d.original_filename, d.filename) n, p.page_no pn, group_concat(t.body, ' ') body
     FROM pages p JOIN documents d ON d.id = p.doc_id JOIN texts t ON t.page_id = p.id GROUP BY p.id`
  )
  .all() as Array<{ n: string; pn: number; body: string }>;
const rand = seededRandom(seed);
const phrases: string[] = [];
while (phrases.length < count) {
  const page = pages[Math.floor(rand() * pages.length)];
  const tokens = foldCase(normalizeText(page.body)).split(/\s+/).filter((t) => /^[\p{L}\p{N}]{3,}$/u.test(t));
  if (tokens.length < 6) continue;
  const len = 1 + Math.floor(rand() * 4);
  const start = Math.floor(rand() * (tokens.length - len));
  phrases.push(tokens.slice(start, start + len).join(" "));
}

/** What the old index read on a page: its text layer and its OCR reading, and whether the new index OCR'd the page. */
function pageTexts(name: string, pageNo: number) {
  const get = (db: Database.Database, kind: string) =>
    (db
      .prepare(
        `SELECT t.body FROM texts t JOIN pages p ON p.id = t.page_id JOIN documents d ON d.id = p.doc_id
         WHERE COALESCE(d.original_filename, d.filename) = ? AND p.page_no = ? AND t.kind = ?`
      )
      .pluck()
      .get(name, pageNo, kind) as string | undefined) ?? "";
  const reason = newDb
    .prepare(
      `SELECT p.source FROM pages p JOIN documents d ON d.id = p.doc_id WHERE COALESCE(d.original_filename, d.filename) = ? AND p.page_no = ?`
    )
    .pluck()
    .get(name, pageNo) as string | undefined;
  return { layer: get(oldDb, "layer"), ocr: get(oldDb, "ocr"), newSource: reason ?? "?" };
}

/** A few words of context around where a phrase sits in a text (loose form), to see what differs. */
function around(text: string, phrase: string): string {
  const t = loosen(foldCase(normalizeText(text)));
  const q = loosen(foldCase(normalizeText(phrase)));
  const i = t.indexOf(q);
  if (i < 0) return "(not in this reading)";
  return "…" + t.slice(Math.max(0, i - 40), i + q.length + 40) + "…";
}

/**
 * Why the new index doesn't find a phrase on a page the old one did:
 *  - "different OCR reading": the new index OCR'd the page too, in English rather than English+Hindi, and the two readings differ.
 *  - "reading order": every word of the phrase is in the page's text layer, just not next to each other
 *    (columns, table cells, wrapped lines); only OCR's line-by-line reading puts them together.
 *  - "OCR noise": the phrase is made of junk OCR read from dotted lines or marks.
 *  - "word missing from the text layer": a word of the phrase is not in the layer at all.
 */
function why(phrase: string, t: { layer: string; newSource: string }): string {
  if (/[^\s]{25,}/.test(phrase) || /(.)\1{4,}/.test(phrase)) return "OCR noise";
  if (t.newSource === "ocr" || t.newSource === "text+ocr") return "different OCR reading";
  const layer = loosen(foldCase(normalizeText(t.layer)));
  const missing = loosen(foldCase(normalizeText(phrase))).split(" ").filter((w) => w && !layer.includes(w));
  return missing.length === 0 ? "reading order" : `word missing from the text layer (${missing.join(", ")})`;
}
const reasons: Record<string, number> = {};
let lostPhrases = 0;
let lostPages = 0;
let oldTotal = 0;
let newTotal = 0;
const report: string[] = [];
for (const mode of ["exact", "loose"] as const) {
  for (const phrase of phrases) {
    const a = hits(oldDb, phrase, mode);
    const b = hits(newDb, phrase, mode);
    oldTotal += a.size;
    newTotal += b.size;
    const lost = [...a].filter((k) => !b.has(k));
    if (lost.length) {
      lostPhrases++;
      lostPages += lost.length;
      report.push(`  [${mode}] "${phrase.slice(0, 60)}": old ${a.size} pages, new ${b.size}; not found in new: ${lost.slice(0, 4).map(short).join(", ")}${lost.length > 4 ? ` (+${lost.length - 4})` : ""}`);
      for (const key of lost.slice(0, 2)) {
        const [name, pn] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
        const t = pageTexts(name, pn);
        const reason = why(phrase, t);
        report.push(`      ${short(name)} p${pn}: ${reason}; old OCR reading ${around(t.ocr, phrase)}`);
      }
      for (const key of lost) {
        const [name, pn] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
        const kind = why(phrase, pageTexts(name, pn)).replace(/ \(.*\)$/, "");
        reasons[kind] = (reasons[kind] ?? 0) + 1;
      }
    }
  }
}
console.log(`${phrases.length} sampled phrases x 2 modes (seed ${seed}); hits old ${oldTotal}, new ${newTotal}`);
console.log(`phrases where the new index finds fewer pages: ${lostPhrases} (${lostPages} pages)`);
console.log(`why, by page lost: ${JSON.stringify(reasons)}`);
for (const line of report) console.log(line);

// For each lost page, why: what the old OCR reading had that the new index doesn't.
console.log("\nKnown-hard checks (exact mode):");
const checks: Array<[string, RegExp, number]> = [
  ["Tiruchirappalli", /^26033Terms/, 97],
  ["Balance Sheet", /^Bidding_docs/, 1],
  ["description", /^26033Terms/, 126],
];
let failed = 0;
for (const [phrase, file, pageNo] of checks) {
  for (const [label, db] of [["old", oldDb], ["new", newDb]] as const) {
    const found = [...hits(db, phrase, "exact")].filter((k) => file.test(k) && k.endsWith(`#${pageNo}`));
    console.log(`  "${phrase}" -> ${file.source.slice(1)} p${pageNo} in ${label} index: ${found.length ? `FOUND (${found.map(short).join(", ")})` : "NOT FOUND"}`);
    if (label === "new" && !found.length) failed++;
  }
}

console.log("\nHindi pages (Bidding_docs pp. 2-3):");
const dev = (s: string) => (s.match(/[ऀ-ॿ]/g) ?? []).length;
const tokens = (s: string) => new Set(loosen(foldCase(normalizeText(s))).split(" ").filter((t) => t.length >= 2));
for (const name of ["Bidding_docs-2026-09-16-04_46_27.pdf", "Bidding_docs-2026-09-23-04_08_50.pdf"]) {
  for (const pn of [2, 3]) {
    const read = (db: Database.Database) =>
      (db
        .prepare(
          `SELECT group_concat(t.body, ' ') FROM texts t JOIN pages p ON p.id = t.page_id JOIN documents d ON d.id = p.doc_id
           WHERE d.original_filename = ? AND p.page_no = ?`
        )
        .pluck()
        .get(name, pn) as string | null) ?? "";
    const a = read(oldDb);
    const b = read(newDb);
    const ta = tokens(a);
    const tb = tokens(b);
    const common = [...ta].filter((t) => tb.has(t)).length;
    console.log(`  ${short(name)} p${pn}: Devanagari chars old ${dev(a)}, new ${dev(b)}; shared words ${common} of ${ta.size} old / ${tb.size} new`);
  }
}
const hindiPhrase = "उत्पाद क्रय विनिर्देश";
for (const [label, db] of [["old", oldDb], ["new", newDb]] as const) {
  const f = [...hits(db, hindiPhrase, "exact")].map(short);
  console.log(`  search "${hindiPhrase}" in ${label}: ${f.length} pages ${f.slice(0, 6).join(", ")}`);
}
void path;
void loadCorpus;
process.exit(failed ? 1 : 0);
