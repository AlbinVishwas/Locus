import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldCase, normalizeText } from "../search/normalize";
import { toFtsPhrase } from "../search/query";
import { LibraryIndexer, type FailureEvent } from "./pipeline";
import { splitLibraryTextId } from "./schema";
import { FolderSource } from "./sources/folder";
import { encryptedPdf, PERMISSIONS } from "./testing/encryptedPdf";
import { fakeGuard, makePdf, snapshotTree, testConfig, type FakeGuard } from "./testing/helpers";
import type { LibraryConfig } from "./config";

/**
 * The library pipeline end to end on real PDFs (poppler + tesseract), with a
 * fake guard standing in for the external drive. SKIP_OCR_TESTS=1 skips it,
 * like the other real-PDF suites.
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";

let root: string;
let src: string;
let data: string;
let work: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-pipeline-"));
  src = path.join(root, "library");
  data = path.join(root, "data");
  work = path.join(root, "work");
  for (const d of [src, data, work]) fs.mkdirSync(d);
});

afterEach(() => {
  execFileSync("chmod", ["-R", "u+rwx", root]);
  fs.rmSync(root, { recursive: true, force: true });
});

const LONG = "The quick ocelot clause appears here, long enough to count as a real text layer.";

async function buildLibrary() {
  await makePdf(path.join(src, "tenders/text.pdf"), [{ lines: [LONG] }, { lines: ["Page two has a different sentence about zebras and money."] }], work);
  await makePdf(path.join(src, "tenders/scan.pdf"), [{ imageWords: "SCANNED OCELOT" }], work);
  fs.writeFileSync(
    path.join(src, "restricted.pdf"),
    encryptedPdf({ text: "restricted ocelot clause, readable without a password", userPassword: "", ownerPassword: "owner", permissions: PERMISSIONS.none })
  );
  fs.writeFileSync(
    path.join(src, "password.pdf"),
    encryptedPdf({ text: "secret ocelot clause", userPassword: "secret", ownerPassword: "owner", permissions: PERMISSIONS.all })
  );
  fs.writeFileSync(path.join(src, "not-really.pdf"), "just some text, no PDF header at all");
  fs.writeFileSync(path.join(src, "corrupt.pdf"), "%PDF-1.4\nthis is not a valid PDF body\n%%EOF\n");
  fs.writeFileSync(path.join(src, "readme.txt"), "not a pdf");
}

function indexer(guard: FakeGuard, config: Partial<LibraryConfig> = {}, extra: Partial<ConstructorParameters<typeof LibraryIndexer>[0]> = {}) {
  const cfg = testConfig(config);
  const failures: FailureEvent[] = [];
  const logs: string[] = [];
  const source = new FolderSource(src, {
    include: cfg.include,
    exclude: cfg.exclude,
    crossDevice: false,
    maxFileBytes: cfg.maxFileBytes,
    settleSeconds: cfg.settleSeconds,
  });
  const ix = new LibraryIndexer({
    config: cfg,
    guard,
    sources: [source],
    onFailure: (e) => failures.push(e),
    log: (l) => logs.push(l),
    reconnectIntervalMs: 10,
    spaceCheckMs: 20,
    idlePollMs: 20,
    ...extra,
  });
  return { ix, failures, logs };
}

function db(): Database.Database {
  return new Database(path.join(data, "library", "library.db"), { readonly: true });
}

function find(query: string): string[] {
  const d = db();
  try {
    const ids = d
      .prepare("SELECT rowid FROM texts_exact WHERE texts_exact MATCH ? ORDER BY rowid")
      .pluck()
      .all(toFtsPhrase(foldCase(normalizeText(query)))) as number[];
    const name = d.prepare("SELECT display_name FROM documents WHERE id = ?").pluck();
    return [...new Set(ids.map((id) => `${name.get(splitLibraryTextId(id).docId)}#${splitLibraryTextId(id).pageNo}`))].sort();
  } finally {
    d.close();
  }
}

function documents() {
  const d = db();
  try {
    return d
      .prepare("SELECT id, key, status, page_count AS pages, pages_done AS done, encryption FROM documents ORDER BY key")
      .all() as Array<{ id: number; key: string; status: string; pages: number; done: number; encryption: string | null }>;
  } finally {
    d.close();
  }
}

function failureRows() {
  const d = db();
  try {
    return d.prepare("SELECT key, kind FROM failures ORDER BY key").all() as Array<{ key: string; kind: string }>;
  } finally {
    d.close();
  }
}

describe.skipIf(skipOcr)("library pipeline", () => {
  it("indexes text, OCR'd scans and restricted PDFs; skips password-protected, not-a-PDF and corrupt files with a reason", async () => {
    await buildLibrary();
    const guard = fakeGuard(data);
    const { ix } = indexer(guard);
    const p = await ix.run();

    expect(p.state).toBe("done");
    expect(documents()).toEqual([
      { id: expect.any(Number), key: "restricted.pdf", status: "ready", pages: 1, done: 1, encryption: "restricted" },
      { id: expect.any(Number), key: "tenders/scan.pdf", status: "ready", pages: 1, done: 1, encryption: null },
      { id: expect.any(Number), key: "tenders/text.pdf", status: "ready", pages: 2, done: 2, encryption: null },
    ]);
    expect(find("ocelot")).toEqual(["restricted.pdf#1", "tenders/scan.pdf#1", "tenders/text.pdf#1"]);
    expect(find("zebras and money")).toEqual(["tenders/text.pdf#2"]);
    expect(failureRows()).toEqual([
      { key: "corrupt.pdf", kind: "corrupt" },
      { key: "not-really.pdf", kind: "not-a-pdf" },
      { key: "password.pdf", kind: "encrypted" },
    ]);
    // Nothing left behind in the drive's temp folder.
    expect(fs.readdirSync(guard.paths.tmp)).toEqual([]);
  }, 120_000);

  it("a second run does no work; then a rename keeps the document, a change re-indexes it, a deletion removes it", async () => {
    await buildLibrary();
    const guard = fakeGuard(data);
    await indexer(guard).ix.run();
    const before = documents();

    const second = await indexer(guard).ix.run();
    expect([second.filesIndexed, second.filesFailed, second.filesRenamed]).toEqual([0, 0, 0]);
    expect(documents()).toEqual(before);

    // Rename text.pdf (same bytes), change scan.pdf, delete restricted.pdf.
    fs.renameSync(path.join(src, "tenders/text.pdf"), path.join(src, "tenders/renamed text.pdf"));
    await makePdf(path.join(src, "tenders/scan.pdf"), [{ lines: ["Completely new content about a pangolin, plenty long enough."] }], work);
    fs.rmSync(path.join(src, "restricted.pdf"));

    const third = await indexer(guard).ix.run();
    expect(third.filesRenamed).toBe(1);
    expect(third.filesIndexed).toBe(1);
    expect(third.filesDeleted).toBe(1);
    const after = documents();
    const renamed = after.find((d) => d.key === "tenders/renamed text.pdf")!;
    // Same row: renamed in place, not extracted again.
    expect(renamed.id).toBe(before.find((d) => d.key === "tenders/text.pdf")!.id);
    expect(after.map((d) => d.key)).toEqual(["tenders/renamed text.pdf", "tenders/scan.pdf"]);
    expect(find("pangolin")).toEqual(["tenders/scan.pdf#1"]);
    expect(find("SCANNED OCELOT")).toEqual([]);
    expect(find("ocelot clause appears")).toEqual(["tenders/renamed text.pdf#1"]);
  }, 180_000);

  it("never writes to the source: a read-only (chmod -R a-w) tree indexes fine and stays byte-identical", async () => {
    await buildLibrary();
    execFileSync("chmod", ["-R", "a-w", src]);
    const before = snapshotTree(src);
    const guard = fakeGuard(data);
    const p = await indexer(guard).ix.run();
    expect(p.filesIndexed).toBe(3);
    expect(snapshotTree(src)).toEqual(before);
  }, 120_000);

  it("drive unplugged mid-run: stops safely, the index passes its check, resumes when it's back; each file indexed exactly once", async () => {
    for (let i = 0; i < 6; i++) {
      await makePdf(path.join(src, `f${i}.pdf`), [{ lines: [`${LONG} file ${i}`] }, { lines: [`second page of file number ${i} here`] }], work);
    }
    const guard = fakeGuard(data);
    let writes = 0;
    const { ix, logs } = indexer(
      guard,
      { filesInFlight: 2, pageWindow: 1 },
      {
        beforeWrite: () => {
          writes++;
          if (writes === 12) {
            // Pull the drive: the guard notices, and the write that was
            // about to happen fails the way SQLite does on a vanished disk.
            guard.connected = false;
            setTimeout(() => (guard.connected = true), 150);
            throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
          }
        },
      }
    );
    const p = await ix.run();
    expect(p.state).toBe("done");
    expect(guard.waits).toBeGreaterThan(0);
    expect(logs.some((l) => l.startsWith("Library drive not connected"))).toBe(true);
    expect(logs.some((l) => l.startsWith("Library drive is back; index checks out"))).toBe(true);

    const d = db();
    try {
      expect(d.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
      const docs = d.prepare("SELECT key, status, pages_done FROM documents ORDER BY key").all();
      expect(docs).toEqual(Array.from({ length: 6 }, (_, i) => ({ key: `f${i}.pdf`, status: "ready", pages_done: 2 })));
      // Exactly once: every page reading the pages table records has one
      // text row, and the full-text indexes hold exactly one row per text.
      // (Page 2's text is under 30 characters, so it's OCR'd as well: two
      // readings.)
      const readings = d.prepare("SELECT sum((layer_chars > 0) + (ocr_chars > 0)) FROM pages").pluck().get();
      expect(readings).toBe(18);
      expect(d.prepare("SELECT count(*) FROM texts").pluck().get()).toBe(readings);
      expect(d.prepare("SELECT count(*) FROM texts_exact_docsize").pluck().get()).toBe(readings);
      expect(d.prepare("SELECT count(*) FROM texts_loose_docsize").pluck().get()).toBe(readings);
      expect(d.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    } finally {
      d.close();
    }
    expect(find("file number 3")).toEqual(["f3.pdf#2"]);
    expect(fs.readdirSync(guard.paths.tmp)).toEqual([]);
  }, 180_000);

  it("pauses on low free space (before starting) and resumes once space is freed", async () => {
    await makePdf(path.join(src, "a.pdf"), [{ lines: [LONG] }], work);
    const guard = fakeGuard(data, 10 * 1024 ** 3);
    guard.free = 1 * 1024 ** 3;
    const { ix, logs } = indexer(guard);
    const states: string[] = [];
    const watcher = setInterval(() => states.push(ix.progress.state), 5);
    setTimeout(() => (guard.free = 50 * 1024 ** 3), 200);
    const p = await ix.run();
    clearInterval(watcher);
    expect(states).toContain("paused: low disk space");
    expect(logs.find((l) => l.startsWith("Paused: low disk space"))).toMatch(/1\.0 GB free, need 10\.0 GB/);
    expect(p.filesIndexed).toBe(1);
  }, 60_000);

  it("a file still being written is deferred, then indexed once it settles", async () => {
    await makePdf(path.join(src, "fresh.pdf"), [{ lines: [LONG] }], work);
    const guard = fakeGuard(data);
    const { ix, failures } = indexer(guard, { settleSeconds: 1 });
    const p = await ix.run();
    expect(p.filesIndexed).toBe(1);
    expect(documents().map((d) => d.status)).toEqual(["ready"]);
    void failures;
  }, 60_000);

  it("a file over the size limit is logged as skipped: too large, and nothing else happens to it", async () => {
    await makePdf(path.join(src, "big.pdf"), [{ lines: [LONG] }], work);
    await makePdf(path.join(src, "small.pdf"), [{ lines: [LONG] }], work);
    const size = fs.statSync(path.join(src, "big.pdf")).size;
    fs.appendFileSync(path.join(src, "big.pdf"), Buffer.alloc(4096));
    const guard = fakeGuard(data);
    const { ix, failures } = indexer(guard, { maxFileBytes: size + 1000 });
    await ix.run();
    expect(documents().map((d) => d.key)).toEqual(["small.pdf"]);
    expect(failureRows()).toEqual([{ key: "big.pdf", kind: "too-large" }]);
    expect(failures.find((f) => f.kind === "too-large")?.message).toMatch(/^skipped: too large/);
  }, 60_000);

  it("a file that runs past the per-file timeout is recorded as a timeout and the run carries on", async () => {
    await makePdf(path.join(src, "a.pdf"), Array.from({ length: 8 }, (_, i) => ({ lines: [`${LONG} ${i}`] })), work);
    const guard = fakeGuard(data);
    const { ix } = indexer(guard, { fileTimeoutMs: 1, pageWindow: 1 });
    const p = await ix.run();
    expect(p.state).toBe("done");
    expect(failureRows()).toEqual([{ key: "a.pdf", kind: "timeout" }]);
    expect(documents()).toEqual([]);
  }, 60_000);

  it("failures aren't retried on every run, only when the file changes or with retryFailed", async () => {
    fs.writeFileSync(path.join(src, "corrupt.pdf"), "%PDF-1.4\ngarbage\n");
    const guard = fakeGuard(data);
    await indexer(guard).ix.run();
    const again = await indexer(guard).ix.run();
    expect(again.filesFailed).toBe(0);
    const retried = await indexer(guard, {}, { retryFailed: true }).ix.run();
    expect(retried.filesFailed).toBe(1);
  }, 60_000);
});
