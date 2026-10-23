import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePdf } from "./testing/helpers";

/**
 * A real indexer process, killed with SIGKILL mid-run (no chance to clean
 * up -- like a crash or a pulled power cord), then run again: the result
 * must be exactly what an uninterrupted run produces, with nothing lost and
 * nothing duplicated. And: a library run writes nowhere except the data
 * dir -- not to TMPDIR, not to HOME, not to the project.
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const HARNESS = path.join(import.meta.dirname, "testing/harness.ts");

let root: string;
let src: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-resume-"));
  src = path.join(root, "library");
  fs.mkdirSync(src);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function harness(dataDir: string, env: Record<string, string> = {}, overrides = { filesInFlight: 2, pageWindow: 1 }): ChildProcess {
  // Started exactly the way package.json starts index:library: node --import
  // tsx with tsx's compile cache off -- the tsx CLI would otherwise write its
  // cache and an IPC pipe into the inherited TMPDIR before any library code
  // runs (which the canary test below would catch).
  return spawn(process.execPath, ["--import", "tsx", HARNESS, src, dataDir, JSON.stringify(overrides)], {
    cwd: ROOT,
    env: { ...process.env, TSX_DISABLE_CACHE: "1", ...env } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function finish(child: ChildProcess): Promise<{ code: number | null; out: string }> {
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
}

function state(dataDir: string) {
  const db = new Database(path.join(dataDir, "library", "library.db"), { readonly: true });
  try {
    return {
      documents: db.prepare("SELECT key, status, page_count, pages_done, sha256 FROM documents ORDER BY key").all(),
      pages: db.prepare("SELECT d.key, p.page_no, p.source, p.layer_chars, p.ocr_chars FROM pages p JOIN documents d ON d.id = p.doc_id ORDER BY d.key, p.page_no").all(),
      texts: db.prepare("SELECT count(*) FROM texts").pluck().get(),
      exactRows: db.prepare("SELECT count(*) FROM texts_exact_docsize").pluck().get(),
      looseRows: db.prepare("SELECT count(*) FROM texts_loose_docsize").pluck().get(),
      jobs: db.prepare("SELECT count(*) FROM jobs").pluck().get(),
      integrity: db.prepare("PRAGMA integrity_check").pluck().get(),
    };
  } finally {
    db.close();
  }
}

function readyCount(dataDir: string): number {
  try {
    const db = new Database(path.join(dataDir, "library", "library.db"), { readonly: true });
    try {
      return Number(db.prepare("SELECT count(*) FROM documents WHERE status = 'ready'").pluck().get());
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

async function buildLibrary(files: number) {
  const work = path.join(root, "work");
  fs.mkdirSync(work, { recursive: true });
  for (let i = 0; i < files; i++) {
    await makePdf(
      path.join(src, `doc${String(i).padStart(2, "0")}.pdf`),
      [
        { lines: [`Document ${i}: a text page with enough characters to count as a text layer.`] },
        { imageWords: `SCAN${i}` },
        { lines: [`Third page of document ${i}, also long enough to be real text here.`] },
      ],
      work
    );
  }
}

describe.skipIf(skipOcr)("crash and resume", () => {
  it("SIGKILL mid-run, then rerun: identical to an uninterrupted run, nothing lost or duplicated", async () => {
    await buildLibrary(10);

    const clean = path.join(root, "clean");
    fs.mkdirSync(clean);
    const ok = await finish(harness(clean));
    expect(ok.code, ok.out).toBe(0);

    const crashed = path.join(root, "crashed");
    fs.mkdirSync(crashed);
    const child = harness(crashed);
    const exited = finish(child);
    // Kill it once some documents are done and others are mid-flight.
    const deadline = Date.now() + 60_000;
    while (readyCount(crashed) < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    child.kill("SIGKILL");
    const killed = await exited;
    expect(killed.code).toBeNull(); // died by signal
    const midway = readyCount(crashed);
    expect(midway).toBeGreaterThanOrEqual(3);
    expect(midway).toBeLessThan(10);
    // The killed process left its lock behind; the next run takes it over.
    expect(fs.existsSync(path.join(crashed, "library", "indexer.lock"))).toBe(true);

    const resumed = await finish(harness(crashed));
    expect(resumed.code, resumed.out).toBe(0);
    expect(resumed.out).toMatch(/Resuming: \d+ file\(s\) a previous run left half-done|DONE/);

    const a = state(clean);
    const b = state(crashed);
    expect(b.integrity).toBe("ok");
    expect(b.documents).toEqual(a.documents);
    expect(b.pages).toEqual(a.pages);
    expect(b.texts).toBe(a.texts);
    expect([b.exactRows, b.looseRows]).toEqual([a.texts, a.texts]);
    expect(b.jobs).toBe(0);
    expect(fs.readdirSync(path.join(crashed, "library", "tmp"))).toEqual([]);
  }, 240_000);
});

describe.skipIf(skipOcr)("storage: a library run writes only under the data dir", () => {
  it("TMPDIR and HOME canaries stay empty, and nothing in the project changes", async () => {
    await buildLibrary(2);
    const data = path.join(root, "data");
    const canaryTmp = path.join(root, "canary-tmp");
    const canaryHome = path.join(root, "canary-home");
    for (const d of [data, canaryTmp, canaryHome]) fs.mkdirSync(d);

    const started = Date.now();
    const run = await finish(harness(data, { TMPDIR: canaryTmp, HOME: canaryHome }));
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain("DONE");

    // OCR ran (so pdftoppm and tesseract wrote their scratch files)...
    expect(state(data).pages.some((p) => (p as { ocr_chars: number }).ocr_chars > 0)).toBe(true);
    // ...but nowhere it inherited: TMPDIR was redirected to the data dir first.
    expect(fs.readdirSync(canaryTmp)).toEqual([]);
    expect(fs.readdirSync(canaryHome)).toEqual([]);

    // Nothing in the project was created or modified by the run.
    const changed: string[] = [];
    const walkProject = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if ([".git", "node_modules", ".next", "data"].includes(e.name) && dir === ROOT) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkProject(full);
        else if (fs.statSync(full).mtimeMs >= started && !full.includes("__snapshots__") && !full.endsWith(".test.ts")) changed.push(path.relative(ROOT, full));
      }
    };
    walkProject(ROOT);
    expect(changed).toEqual([]);

    // Everything the run wrote is under the data dir.
    expect(fs.readdirSync(path.join(data, "library")).sort()).toEqual(
      ["inventory", "library.db", "library.db-shm", "library.db-wal", "logs", "ocr-cache.db", "tmp"].filter((n) =>
        fs.existsSync(path.join(data, "library", n))
      )
    );
    expect(fs.readdirSync(path.join(data, "library", "tmp"))).toEqual([]);
  }, 120_000);
});
