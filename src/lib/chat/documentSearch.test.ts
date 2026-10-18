import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUploadedDocument, openIndex } from "../../../scripts/indexer/store";
import { extractQuotedText, runDocumentSearch } from "./documentSearch";

let dir: string;

function page(layerText: string) {
  return {
    pageNo: 1,
    pageLabel: null,
    source: "text" as const,
    ocrReason: null,
    imageCoverage: 0,
    layerText,
    ocrText: null,
    error: null,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assay-docsearch-"));
  process.env.SEARCH_INDEX_PATH = path.join(dir, "index", "search.db");
});

afterEach(() => {
  delete process.env.SEARCH_INDEX_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("extractQuotedText", () => {
  it("finds the first quoted phrase", () => {
    expect(extractQuotedText('does it say "26-2080" anywhere')).toBe("26-2080");
  });

  it("returns null when there's no quote", () => {
    expect(extractQuotedText("does it mention earnest money")).toBeNull();
  });

  it("ignores an empty quoted pair", () => {
    expect(extractQuotedText('nothing in here: ""')).toBeNull();
  });
});

describe("runDocumentSearch", () => {
  it("returns null when the conversation has no documents", () => {
    expect(runDocumentSearch("conv-empty", "anything")).toBeNull();
  });

  it("searches the whole message when it has no quotes", () => {    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId: "conv-1",
      originalFilename: "Notice.pdf",
      storedFilename: "a.pdf",
      sha256: "a",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [page("the aardvark deposit clause")],
    });
    db.close();

    const outcome = runDocumentSearch("conv-1", "aardvark deposit");
    expect(outcome).not.toBeNull();
    expect(outcome!.result.hits).toHaveLength(1);
  });

  it("searches only the quoted text when the message has a quote", () => {    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId: "conv-2",
      originalFilename: "Notice.pdf",
      storedFilename: "b.pdf",
      sha256: "b",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [page("Tender 26-2080 dated today")],
    });
    db.close();

    // The message's own words ("does", "say") don't appear in the page, but
    // the quoted text does -- confirming only the quote was searched.
    const outcome = runDocumentSearch("conv-2", 'does it say "26-2080" anywhere');
    expect(outcome).not.toBeNull();
    expect(outcome!.result.hits).toHaveLength(1);
  });

  it("offers a loose-mode alternative only when exact finds nothing and loose finds something", () => {    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId: "conv-3",
      originalFilename: "Notice.pdf",
      storedFilename: "c.pdf",
      sha256: "c",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [page("Reference 26/2080 appears here")],
    });
    db.close();

    const outcome = runDocumentSearch("conv-3", "26-2080");
    expect(outcome).not.toBeNull();
    expect(outcome!.result.hits).toHaveLength(0);
    expect(outcome!.looseAlternative).not.toBeNull();
    expect(outcome!.looseAlternative!.hits.length).toBeGreaterThan(0);
  });

  it("never finds another conversation's upload", () => {    const db = openIndex(process.env.SEARCH_INDEX_PATH!);
    insertUploadedDocument(db, {
      conversationId: "conv-mine",
      originalFilename: "Mine.pdf",
      storedFilename: "d.pdf",
      sha256: "d",
      sizeBytes: 1,
      ocrLang: "eng",
      settings: "v1",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      pages: [page("private pangolin figures")],
    });
    db.close();

    expect(runDocumentSearch("conv-other", "pangolin")).toBeNull();
  });
});
