import type Database from "better-sqlite3";
import { uploadedDocuments } from "../../../../scripts/indexer/store";
import { storedPathFor } from "../../uploads/storage";
import type { LibrarySource, OpenedFile, SourceEntry } from "./types";

/**
 * One session's uploads, seen through the source interface. A thin
 * adapter: it only reads what the existing upload flow already wrote (the
 * session index and data/uploads), and changes nothing about how uploads
 * work, where they're stored, or how they're indexed -- the library
 * indexer doesn't index uploads; they're already in the session index.
 * It exists so code that treats documents by source (a "Both" search,
 * future sources) can include uploads without special cases.
 */
export class UploadSource implements LibrarySource {
  readonly kind = "upload" as const;
  readonly id: string;
  readonly label: string;
  readonly name = "Session uploads";

  constructor(
    private readonly db: Database.Database,
    private readonly conversationId: string
  ) {
    this.id = `upload:${conversationId}`;
    this.label = "session uploads";
  }

  async *scan(): AsyncIterable<SourceEntry> {
    for (const doc of uploadedDocuments(this.db, this.conversationId)) {
      yield {
        key: String(doc.id),
        displayName: doc.originalFilename,
        locator: doc.sha256,
        sizeBytes: doc.sizeBytes,
        modifiedAt: doc.uploadedAt,
      };
    }
  }

  async open(entry: SourceEntry): Promise<OpenedFile> {
    return {
      path: storedPathFor(entry.locator),
      sha256: entry.locator,
      sizeBytes: entry.sizeBytes ?? 0,
      modifiedAt: entry.modifiedAt,
      cleanup: async () => {},
    };
  }

  async close(): Promise<void> {}
}
