import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * OCR results keyed by (file content hash, page, language, DPI). OCR is the
 * one slow step (seconds per page), so a page is only ever OCR'd once for a
 * given file content and settings: renaming a file, rebuilding the index with
 * --force, or running the mixed-page measurement all reuse earlier work.
 * A changed file has a new hash, so its pages are always OCR'd afresh.
 */
export class OcrCache {
  private db: Database.Database;
  private getStmt: Database.Statement;
  private putStmt: Database.Statement;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ocr (
        sha256  TEXT NOT NULL,
        page_no INTEGER NOT NULL,
        lang    TEXT NOT NULL,
        dpi     INTEGER NOT NULL,
        text    TEXT NOT NULL,
        PRIMARY KEY (sha256, page_no, lang, dpi)
      )`);
    this.getStmt = this.db
      .prepare("SELECT text FROM ocr WHERE sha256 = ? AND page_no = ? AND lang = ? AND dpi = ?")
      .pluck();
    this.putStmt = this.db.prepare(
      "INSERT OR REPLACE INTO ocr (sha256, page_no, lang, dpi, text) VALUES (?, ?, ?, ?, ?)"
    );
  }

  get(sha256: string, pageNo: number, lang: string, dpi: number): string | undefined {
    return this.getStmt.get(sha256, pageNo, lang, dpi) as string | undefined;
  }

  put(sha256: string, pageNo: number, lang: string, dpi: number, text: string): void {
    this.putStmt.run(sha256, pageNo, lang, dpi, text);
  }

  /** Drops every cached OCR result for one file's content, once nothing references it any more (retention cleanup, or an upload deleted with its conversation). */
  deleteForFile(sha256: string): void {
    this.db.prepare("DELETE FROM ocr WHERE sha256 = ?").run(sha256);
  }

  close(): void {
    this.db.close();
  }
}
