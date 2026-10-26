import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { walk, type SkipRecord } from "../walk";
import { isDataless, openLocalPdf } from "./localFile";
import type { LibrarySource, OpenedFile, SourceEntry } from "./types";

/**
 * LOCUS_LIBRARY_DIR: a folder of PDFs, walked recursively (walk.ts),
 * read in place, never written, never copied, never served by the app.
 */

export interface FolderSourceOptions {
  include: string[];
  exclude: string[];
  crossDevice: boolean;
  maxFileBytes: number;
  settleSeconds: number;
  now?: () => number;
}

export class FolderSource implements LibrarySource {
  readonly kind = "folder" as const;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  private readonly root: string;

  constructor(
    root: string,
    private readonly options: FolderSourceOptions
  ) {
    this.root = fs.realpathSync(root);
    this.id = `folder:${createHash("sha1").update(this.root).digest("hex").slice(0, 16)}`;
    this.label = `folder ${this.root}`;
    this.name = path.basename(this.root) || "Folder";
  }

  async *scan(signal: AbortSignal, onSkip: (skip: SkipRecord) => void, onOther?: () => void): AsyncIterable<SourceEntry> {
    const now = this.options.now ?? Date.now;
    const settleMs = this.options.settleSeconds * 1000;
    for await (const f of walk(this.root, {
      include: this.options.include,
      exclude: this.options.exclude,
      crossDevice: this.options.crossDevice,
      onSkip,
      onOther,
      signal,
    })) {
      if (f.size > this.options.maxFileBytes) {
        onSkip({
          relPath: f.relPath,
          reason: "too-large",
          isDirectory: false,
          detail: `skipped: too large (${f.size} bytes, limit ${this.options.maxFileBytes})`,
        });
        continue;
      }
      if (await isDataless(f.absPath, f)) {
        onSkip({ relPath: f.relPath, reason: "not-downloaded", isDirectory: false, detail: "online-only file (not downloaded)" });
        continue;
      }
      const entry: SourceEntry = {
        key: f.relPath,
        displayName: f.relPath,
        locator: f.absPath,
        sizeBytes: f.size,
        modifiedAt: new Date(f.mtimeMs).toISOString(),
      };
      if (settleMs > 0 && now() - f.mtimeMs < settleMs) {
        entry.notBefore = new Date(f.mtimeMs + settleMs).toISOString();
      }
      yield entry;
    }
  }

  open(entry: SourceEntry, _tempDir: string, signal: AbortSignal): Promise<OpenedFile> {
    return openLocalPdf(entry.locator, {
      maxFileBytes: this.options.maxFileBytes,
      settleMs: this.options.settleSeconds * 1000,
      signal,
      now: this.options.now,
    });
  }

  async close(): Promise<void> {}
}
