import Database from "better-sqlite3";
import { PAGE_SOURCES, type PageSource } from "../../src/lib/search/schema";

/**
 * The index report: for every document, how each page was read. Built from
 * the index itself (not from what this run happened to do), so it always
 * covers the whole collection and a gap anywhere is visible.
 */

export interface DocumentReport {
  filename: string;
  pageCount: number;
  rows: number;
  bySource: Record<PageSource, number>;
  /** OCR'd pages where tesseract found no text — worth a look by eye. */
  ocrEmpty: number[];
  ocrPages: Array<{ pageNo: number; reason: string; coverage: number }>;
  failedPages: Array<{ pageNo: number; error: string }>;
  blankPages: number[];
  error: string | null;
}

export interface IndexReport {
  documents: DocumentReport[];
  totals: Record<PageSource, number> & { pages: number; documents: number; ocrEmpty: number };
  /** Documents whose page rows don't add up to their page count. Must be empty. */
  missingPages: string[];
}

export function buildReport(indexPath: string): IndexReport {
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    const docs = db
      .prepare("SELECT id, filename, page_count, error FROM documents ORDER BY filename")
      .all() as Array<{ id: number; filename: string; page_count: number; error: string | null }>;
    const pagesStmt = db.prepare(
      `SELECT page_no, source, ocr_reason, image_coverage, ocr_chars, error
       FROM pages WHERE doc_id = ? ORDER BY page_no`
    );

    const zero = () => Object.fromEntries(PAGE_SOURCES.map((s) => [s, 0])) as Record<PageSource, number>;
    const totals = { ...zero(), pages: 0, documents: docs.length, ocrEmpty: 0 };
    const missingPages: string[] = [];

    const documents = docs.map((d): DocumentReport => {
      const pages = pagesStmt.all(d.id) as Array<{
        page_no: number;
        source: PageSource;
        ocr_reason: string | null;
        image_coverage: number;
        ocr_chars: number;
        error: string | null;
      }>;
      const report: DocumentReport = {
        filename: d.filename,
        pageCount: d.page_count,
        rows: pages.length,
        bySource: zero(),
        ocrEmpty: [],
        ocrPages: [],
        failedPages: [],
        blankPages: [],
        error: d.error,
      };
      for (const p of pages) {
        report.bySource[p.source]++;
        totals[p.source]++;
        if (p.ocr_reason) {
          report.ocrPages.push({ pageNo: p.page_no, reason: p.ocr_reason, coverage: p.image_coverage });
          if ((p.source === "ocr" || p.source === "text+ocr") && p.ocr_chars === 0) {
            report.ocrEmpty.push(p.page_no);
          }
        }
        if (p.source === "blank") report.blankPages.push(p.page_no);
        if (p.source === "failed") report.failedPages.push({ pageNo: p.page_no, error: p.error ?? "" });
      }
      totals.pages += pages.length;
      totals.ocrEmpty += report.ocrEmpty.length;
      const numbered = pages.every((p, i) => p.page_no === i + 1);
      if (pages.length !== d.page_count || !numbered || d.error) missingPages.push(d.filename);
      return report;
    });

    return { documents, totals, missingPages };
  } finally {
    db.close();
  }
}

/** "3,4,5,9" -> "3-5, 9" */
export function pageRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

export function formatReport(report: IndexReport): string {
  const lines: string[] = [];
  const header = ["pages", "text", "text+ocr", "ocr", "blank", "failed", "ocr-empty"];
  const nameWidth = Math.min(
    60,
    Math.max(8, ...report.documents.map((d) => d.filename.length))
  );
  const row = (name: string, cells: (string | number)[]) =>
    `${name.padEnd(nameWidth).slice(0, nameWidth)}  ${cells.map((c) => String(c).padStart(8)).join(" ")}`;

  lines.push("INDEX REPORT", "");
  lines.push(row("document", header));
  lines.push("-".repeat(nameWidth + 2 + header.length * 9));
  for (const d of report.documents) {
    const s = d.bySource;
    lines.push(
      row(d.filename, [d.pageCount, s.text, s["text+ocr"], s.ocr, s.blank, s.failed, d.ocrEmpty.length])
    );
  }
  const t = report.totals;
  lines.push("-".repeat(nameWidth + 2 + header.length * 9));
  lines.push(row(`TOTAL (${t.documents} documents)`, [t.pages, t.text, t["text+ocr"], t.ocr, t.blank, t.failed, t.ocrEmpty]));
  lines.push("");

  lines.push("Pages OCR'd, and why:");
  let anyOcr = false;
  for (const d of report.documents) {
    const byReason = new Map<string, number[]>();
    for (const p of d.ocrPages) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), p.pageNo]);
    for (const [reason, pages] of byReason) {
      anyOcr = true;
      // Under OCR_PAGES=all most pages carry this reason; a count says enough.
      lines.push(
        reason === "all-pages"
          ? `  ${d.filename}: all-pages (policy) -> ${pages.length} page(s)`
          : `  ${d.filename}: ${reason} -> p ${pageRanges(pages)}`
      );
    }
  }
  if (!anyOcr) lines.push("  (none)");
  lines.push("");

  const blanks = report.documents.filter((d) => d.bySource.blank > 0);
  lines.push("Blank pages (no ink when rendered):");
  if (blanks.length === 0) lines.push("  (none)");
  lines.push(...blanks.map((d) => `  ${d.filename}: p ${pageRanges(d.blankPages)}`));
  lines.push("");

  lines.push("Failed pages and documents:");
  const failures = report.documents.filter((d) => d.failedPages.length > 0 || d.error);
  if (failures.length === 0) lines.push("  (none)");
  for (const d of failures) {
    if (d.error) lines.push(`  ${d.filename}: DOCUMENT FAILED: ${d.error}`);
    for (const f of d.failedPages) lines.push(`  ${d.filename} p${f.pageNo}: ${f.error}`);
  }
  lines.push("");

  const empties = report.documents.filter((d) => d.ocrEmpty.length > 0);
  if (empties.length > 0) {
    lines.push("OCR found no text on (check by eye):");
    for (const d of empties) lines.push(`  ${d.filename}: p ${pageRanges(d.ocrEmpty)}`);
    lines.push("");
  }

  lines.push(
    report.missingPages.length === 0
      ? "Completeness: every document has exactly one row per page."
      : `Completeness: PROBLEM in ${report.missingPages.join(", ")}`
  );
  return lines.join("\n");
}
