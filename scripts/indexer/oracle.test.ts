import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compare, loadCorpus } from "./oracle";
import { insertUploadedDocument, openIndex } from "./store";

/**
 * The brute-force checker itself, on an index holding conversation
 * uploads: an upload is shown and filename-matched under its original
 * name, not its content-addressed name on disk, the same file can be
 * uploaded into two conversations, and expired uploads are out of
 * search's reach. None of that may read as the index being wrong.
 */

let dir: string;

function upload(db: ReturnType<typeof openIndex>, conversationId: string, expiresAt: string | null) {
  insertUploadedDocument(db, {
    conversationId,
    originalFilename: "Earnest_Notice.pdf",
    storedFilename: "0f1e2d3c.pdf",
    sha256: "0f1e2d3c",
    sizeBytes: 1,
    ocrLang: "eng",
    settings: "v1",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
    pages: [
      {
        pageNo: 1,
        pageLabel: null,
        source: "text",
        ocrReason: null,
        imageCoverage: 0,
        layerText: "the ocelot deposit clause",
        ocrText: null,
        error: null,
      },
    ],
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-oracle-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("oracle with uploads in the index", () => {
  it("agrees with search on page text and filenames, across duplicate and expired uploads", () => {
    const db = openIndex(path.join(dir, "search.db"));
    upload(db, "conv-1", null);
    upload(db, "conv-2", null);
    upload(db, "conv-3", "2000-01-01T00:00:00.000Z"); // expired
    const corpus = loadCorpus(db);
    for (const mode of ["exact", "loose"] as const) {
      expect(compare(db, corpus, "ocelot deposit", mode)).toBeNull();
      expect(compare(db, corpus, "earnest_notice", mode)).toBeNull();
      expect(compare(db, corpus, "0f1e2d3c", mode)).toBeNull();
    }
    db.close();
  });
});
