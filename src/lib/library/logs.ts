import fs from "node:fs";

/**
 * Append-only log files on the external drive, rotated by size so a
 * multi-day run can't fill the disk with logs: at `maxBytes` the file
 * becomes .1 (the old .1 becomes .2, and so on), keeping `keep` old files.
 */
export class RotatingLog {
  private size: number;

  constructor(
    private readonly file: string,
    private readonly maxBytes = 50 * 1024 * 1024,
    private readonly keep = 10
  ) {
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(line: string): void {
    const data = line.endsWith("\n") ? line : `${line}\n`;
    if (this.size + Buffer.byteLength(data) > this.maxBytes) this.rotate();
    try {
      fs.appendFileSync(this.file, data);
      this.size += Buffer.byteLength(data);
    } catch {
      // The drive may be gone; the indexer handles that. A log line is never worth crashing over.
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // as above
    }
    this.size = 0;
  }
}
