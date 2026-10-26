import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SkipRecord } from "../walk";
import { DriveApi, DriveError, FOLDER_MIME, type DriveFile } from "./gdriveApi";
import { hasPdfHeader } from "./localFile";
import { SourceFileError, type LibrarySource, type OpenedFile, type SourceEntry } from "./types";

/**
 * A public Google Drive folder, listed recursively and downloaded one PDF at
 * a time: each file goes to the temp folder, is indexed, and is deleted at
 * once (OpenedFile.cleanup). Nothing is kept.
 *
 * Identity is the Drive file id; the name shown is the path inside the shared
 * folder. Change detection is modifiedTime + size (a PDF's content can't
 * change without both moving or the md5 changing); an unchanged file is
 * never downloaded. The download is checked against Drive's md5 so a
 * truncated transfer is caught rather than indexed.
 */

export interface GoogleDriveSourceOptions {
  /** The registry id, so the library index keys on it. */
  id: string;
  name: string;
  folderId: string;
  api: DriveApi;
  maxFileBytes: number;
}

interface DriveLocator {
  id: string;
  md5: string | null;
  size: number | null;
}

export class GoogleDriveSource implements LibrarySource {
  readonly kind = "drive" as const;
  readonly id: string;
  readonly name: string;
  readonly label: string;

  constructor(private readonly o: GoogleDriveSourceOptions) {
    this.id = o.id;
    this.name = o.name;
    this.label = `Google Drive folder ${o.name}`;
  }

  async *scan(signal: AbortSignal, onSkip: (skip: SkipRecord) => void, onOther?: () => void): AsyncIterable<SourceEntry> {
    // The folder itself must be reachable: this is where "not shared" surfaces.
    await this.o.api.getFolder(this.o.folderId, signal);

    // Depth-first with an explicit stack: memory is bounded by the number of
    // folders waiting, not by the number of files.
    const stack: Array<{ id: string; prefix: string }> = [{ id: this.o.folderId, prefix: "" }];
    const seen = new Set<string>([this.o.folderId]); // a folder can have several parents
    while (stack.length > 0 && !signal.aborted) {
      const folder = stack.pop()!;
      let pageToken: string | undefined;
      do {
        const page = await this.o.api.listChildren(folder.id, pageToken, signal);
        pageToken = page.nextPageToken;
        const subfolders: Array<{ id: string; prefix: string }> = [];
        for (const f of page.files) {
          if (f.mimeType === FOLDER_MIME) {
            if (!seen.has(f.id)) {
              seen.add(f.id);
              subfolders.push({ id: f.id, prefix: `${folder.prefix}${f.name}/` });
            }
            continue;
          }
          if (f.mimeType !== "application/pdf") {
            onOther?.(); // Google Docs, Sheets, shortcuts, images...
            continue;
          }
          const entry = this.entryFor(f, folder.prefix, onSkip);
          if (entry) yield entry;
        }
        // Pushed in reverse so the walk visits them in name order.
        stack.push(...subfolders.reverse());
      } while (pageToken && !signal.aborted);
    }
  }

  private entryFor(f: DriveFile, prefix: string, onSkip: (s: SkipRecord) => void): SourceEntry | null {
    const displayName = `${prefix}${f.name}`;
    const size = f.size === undefined ? null : Number(f.size);
    if (size !== null && size > this.o.maxFileBytes) {
      onSkip({ relPath: displayName, reason: "too-large", isDirectory: false, detail: `skipped: too large (${size} bytes)` });
      return null;
    }
    const locator: DriveLocator = { id: f.id, md5: f.md5Checksum ?? null, size };
    return { key: f.id, displayName, locator: JSON.stringify(locator), sizeBytes: size, modifiedAt: f.modifiedTime ?? null };
  }

  async open(entry: SourceEntry, tempDir: string, signal: AbortSignal): Promise<OpenedFile> {
    const loc = JSON.parse(entry.locator) as DriveLocator;
    let res: Response;
    try {
      res = await this.o.api.download(loc.id, signal);
    } catch (err) {
      if (err instanceof DriveError) {
        throw new SourceFileError(err.code === "not-found" || err.code === "not-shared" ? "vanished" : "unreadable", err.message);
      }
      throw err;
    }
    if (!res.body) throw new SourceFileError("unreadable", "Google Drive sent an empty response.");

    const file = path.join(tempDir, `gd-${randomUUID()}.pdf`);
    const sha = createHash("sha256");
    const md5 = createHash("md5");
    let total = 0;
    let first: Buffer | null = null;
    const max = this.o.maxFileBytes;
    try {
      await pipeline(
        Readable.fromWeb(res.body as never),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            total += chunk.length;
            if (total > max) throw new SourceFileError("too-large", `skipped: too large (over ${max} bytes)`);
            if (first === null) first = Buffer.from(chunk.subarray(0, 1024));
            sha.update(chunk);
            md5.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(file),
        { signal }
      );
    } catch (err) {
      await fs.promises.rm(file, { force: true });
      if (err instanceof SourceFileError) throw err;
      if (signal.aborted) throw err;
      throw new SourceFileError("unreadable", `Download failed (${err instanceof Error ? err.message : String(err)}).`);
    }
    if (loc.md5 && md5.digest("hex") !== loc.md5) {
      await fs.promises.rm(file, { force: true });
      throw new SourceFileError("unreadable", "The download didn't match Google Drive's checksum (a partial transfer?). Rescan to try again.");
    }
    if (!first || !hasPdfHeader(first)) {
      await fs.promises.rm(file, { force: true });
      throw new SourceFileError("not-a-pdf", "skipped: not a PDF (no %PDF- header)");
    }
    return {
      path: file,
      sha256: sha.digest("hex"),
      sizeBytes: total,
      modifiedAt: entry.modifiedAt,
      cleanup: () => fs.promises.rm(file, { force: true }),
    };
  }

  async close(): Promise<void> {}
}
