import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLibraryConfig, libraryPaths } from "../library/config";
import { beginDocument, markDocumentReady, openLibraryDb, recordFailure, registerSource, writePages, writeWorkerStatus } from "../library/store";
import { buildServerStatus, describeFailure, SERVER_SOURCE_ID } from "./status";

vi.mock("./tools", () => ({ checkToolsCached: () => ({ poppler: { ok: true, missing: [] }, tesseract: { ok: true, languages: ["eng", "hin"], hasEnglish: true, hasHindi: true } }) }));

let dir: string;
beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-status-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config = (extra: Record<string, string> = {}) => loadLibraryConfig({ LOCUS_DATA_DIR: dir, LOCUS_SERVER_TYPE: "folder", LOCUS_SERVER_PATH: "/srv/tenders", LOCUS_SERVER_WATCH: "false", ...extra });

function index() {
  const db = openLibraryDb(libraryPaths(dir).db);
  registerSource(db, { id: SERVER_SOURCE_ID, kind: "server", label: "server", name: "Company server" });
  for (const key of ["a.pdf", "b.pdf"]) {
    const id = beginDocument(db, { sourceId: SERVER_SOURCE_ID, key, displayName: key, sizeBytes: 1000, modifiedAt: null, sha256: key, pageCount: 1, ocrLang: "eng", settings: "x", encryption: null, scanId: 1 });
    writePages(db, id, [{ pageNo: 1, pageLabel: null, source: "text", ocrReason: null, imageCoverage: 0, layerText: "text", ocrText: null, error: null }]);
    markDocumentReady(db, id);
  }
  recordFailure(db, { sourceId: SERVER_SOURCE_ID, key: "bad.pdf", displayName: "bad.pdf", kind: "corrupt", message: "pdfinfo failed: Syntax Error: Couldn't find trailer", scanId: 1 });
  return db;
}

describe("failure reasons in plain words", () => {
  it("every kind has a sentence a person can read, and unknown kinds fall back to the message", () => {
    for (const k of ["corrupt", "encrypted", "timeout", "too-large", "not-a-pdf", "permission-denied", "vanished"]) expect(describeFailure(k, "raw tool text")).not.toContain("raw tool text");
    expect(describeFailure("corrupt", null)).toBe("This PDF is damaged, so it can't be read.");
    expect(describeFailure("other", "something specific")).toBe("something specific");
  });
});

describe("buildServerStatus", () => {
  it("with no server: not configured", () => {
    expect(buildServerStatus(null, loadLibraryConfig({ LOCUS_DATA_DIR: dir }))).toMatchObject({ configured: false, type: "none", banner: null });
  });

  it("bad settings are reported on the page instead of crashing, with the setting's name", () => {
    const s = buildServerStatus(null, loadLibraryConfig({ LOCUS_DATA_DIR: dir, LOCUS_SERVER_TYPE: "folder" }));
    expect(s.configError).toMatch(/LOCUS_SERVER_PATH/);
    expect(s.banner).toMatchObject({ code: "LOCUS-SERVER-003", tone: "error" });
  });

  it("counts, progress, failures with readable reasons, and the banner when the indexer isn't running", () => {
    const db = index();
    db.prepare("INSERT INTO scans (source_id, started_at, finished_at, completed, files_seen) VALUES (?, '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 1, 3)").run(SERVER_SOURCE_ID);
    const s = buildServerStatus(db, config());
    expect(s).toMatchObject({ configured: true, type: "folder", label: "Folder /srv/tenders", syncIntervalMin: 10 });
    expect(s.index).toMatchObject({ documents: 2, failed: 1, pending: 0, total: 3, percent: 100 });
    expect(s.sync.lastSyncedAt).toBe("2026-01-01T00:01:00Z");
    expect(s.failures).toEqual([expect.objectContaining({ file: "bad.pdf", kind: "corrupt", message: "This PDF is damaged, so it can't be read.", detail: expect.stringContaining("pdfinfo failed") })]);
    expect(s.banner).toMatchObject({ title: "The indexer isn't running", tone: "warning" });
    db.close();
  });

  it("a server problem recorded by the indexer becomes the banner, with its catalog code; search isn't mentioned as broken", () => {
    const db = index();
    db.prepare("UPDATE sources SET last_error = ? WHERE id = ?").run("LOCUS-SERVER-001: Can't reach the storage server. the server folder wasn't found", SERVER_SOURCE_ID);
    const s = buildServerStatus(db, config());
    expect(s.sync.error).toMatchObject({ code: "LOCUS-SERVER-001" });
    expect(s.banner).toMatchObject({ code: "LOCUS-SERVER-001", tone: "error", title: "Can't reach the storage server" });
    expect(s.index.documents).toBe(2); // what is indexed is still there to search
    db.close();
  });

  it("a storage pause shows the disk message; a running indexer with work left shows 'still being built' with an ETA", () => {
    const db = index();
    writeWorkerStatus(db, { pid: 1, heartbeatAt: new Date().toISOString(), state: "paused: low disk space", scanning: false, limit: { kind: "reserve", message: "Paused: low disk space. 1.0 GB free; Locus keeps 5 GB in reserve." }, usedBytes: 1e6, capBytes: 1e11, freeBytes: 1e9, minFreeBytes: 5e9, filesIndexed: 2, pagesDone: 2, ocrRun: 0 });
    expect(buildServerStatus(db, config()).banner).toMatchObject({ code: "LOCUS-DISK-002", tone: "warning" });

    writeWorkerStatus(db, { pid: 1, heartbeatAt: new Date().toISOString(), state: "running", scanning: false, limit: null, usedBytes: 1e6, capBytes: 1e11, freeBytes: 5e10, minFreeBytes: 5e9, filesIndexed: 2, pagesDone: 2, ocrRun: 0 });
    db.prepare("INSERT INTO jobs (source_id, key, locator, display_name, action, state, enqueued_at, updated_at) VALUES (?, 'c.pdf', '{}', 'c.pdf', 'index', 'pending', 'x', 'x')").run(SERVER_SOURCE_ID);
    db.prepare("UPDATE documents SET indexed_at = ? WHERE source_id = ?").run(new Date().toISOString(), SERVER_SOURCE_ID);
    const s = buildServerStatus(db, config());
    expect(s.index).toMatchObject({ pending: 1, total: 4 });
    expect(s.index.etaSeconds).toBeGreaterThan(0);
    expect(s.banner).toMatchObject({ code: "LOCUS-INDEX-001", tone: "info" });
    db.close();
  });
});
