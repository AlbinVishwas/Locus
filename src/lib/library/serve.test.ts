import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLibraryConfig } from "./config";
import { LibraryIndexer } from "./pipeline";
import { addRegistrySource, getRegistrySource, listRegistry, openRegistry, requestRescan, setSourceState, updateSourceConfig } from "./sources/registry";
import { FOLDER_MIME } from "./sources/gdriveApi";
import { fakeGuard, makePdf, snapshotTree, testConfig, type FakeGuard } from "./testing/helpers";
import { startMockDrive, type MockDrive } from "./testing/mockDrive";
import { createRegistryControl, syncEnvSources, type RegistryControl } from "./worker";

/**
 * The indexer as a service, driven by the sources registry, on real PDFs
 * (poppler + tesseract): a source added with no restart, Rescan, Pause and
 * Resume, Remove (index entries only), bad settings as an error, the
 * storage limit, and the .env source.
 */

const skipOcr = process.env.SKIP_OCR_TESTS === "1";
const LONG = "The quick ocelot clause appears here, long enough to count as a real text layer.";

let base: string;
let roots: string;
let data: string;
let work: string;
let guard: FakeGuard;
let registry: Database.Database;
let control: RegistryControl;
let indexer: LibraryIndexer;
let running: Promise<unknown>;
let logs: string[];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-serve-")));
  roots = path.join(base, "Volumes");
  data = path.join(base, "data");
  work = path.join(base, "work");
  for (const d of [roots, data, work]) fs.mkdirSync(d);
  logs = [];
});

afterEach(async () => {
  indexer?.stop();
  await running?.catch(() => {});
  await control?.close();
  registry?.close();
  fs.rmSync(base, { recursive: true, force: true });
});

function start(overrides: Parameters<typeof testConfig>[0] = {}, env: Record<string, string | undefined> = {}) {
  const config = testConfig({ dataDir: data, allowedRoots: [roots], filesInFlight: 2, pageWindow: 1, rescanMinutes: 100_000, ...overrides });
  guard = fakeGuard(data);
  registry = openRegistry(guard.paths.sources);
  control = createRegistryControl(registry, config, env);
  indexer = new LibraryIndexer({ config, guard, sources: [], log: (l) => logs.push(l), idlePollMs: 20, spaceCheckMs: 20, reconnectIntervalMs: 10 });
  running = indexer.serve(control, { pollMs: 40 });
  return config;
}

const lib = () => new Database(path.join(data, "library", "library.db"), { readonly: true });
function q<T>(sql: string, ...params: unknown[]): T[] {
  const d = lib();
  try {
    return d.prepare(sql).all(...params) as T[];
  } finally {
    d.close();
  }
}
const count = (sql: string, ...params: unknown[]) => Number(Object.values(q<Record<string, number>>(sql, ...params)[0])[0]);

async function until(fn: () => boolean, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (fn()) return;
    } catch {
      // the library file may not exist yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${logs.slice(-15).join("\n")}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function folderWith(name: string, n: number, tag = name): Promise<string> {
  const dir = path.join(roots, name);
  for (let i = 0; i < n; i++) {
    await makePdf(path.join(dir, `${tag}-${i}.pdf`), [{ lines: [`${LONG} ${tag} file ${i}`] }, { lines: [`second page ${tag} ${i}`] }], work);
  }
  return dir;
}

const ready = (sourceId: string) => count("SELECT count(*) FROM documents WHERE source_id = ? AND status = 'ready'", sourceId);

describe.skipIf(skipOcr)("the indexer as a service", () => {
  it("indexes a source as soon as it's added -- no restart -- and publishes what it's doing", async () => {
    start();
    const dir = await folderWith("Tenders", 3);
    const s = addRegistrySource(registry, { kind: "folder", name: "Tenders 2026", config: { path: dir } });
    await until(() => ready(s.id) === 3, "3 documents ready");

    expect(q("SELECT id, kind, name, ordinal, last_error FROM sources")).toEqual([{ id: s.id, kind: "folder", name: "Tenders 2026", ordinal: 1, last_error: null }]);
    expect(q("SELECT display_name FROM documents").map((r) => (r as { display_name: string }).display_name).sort()).toEqual(["Tenders-0.pdf", "Tenders-1.pdf", "Tenders-2.pdf"]);
    const status = JSON.parse((q<{ value: string }>("SELECT value FROM meta WHERE key = 'worker_status'")[0]).value);
    expect(status).toMatchObject({ pid: process.pid, state: "running", limit: null });
    expect(Date.now() - Date.parse(status.heartbeatAt)).toBeLessThan(5000);
    // A completed scan is recorded, with its counts.
    expect(q("SELECT completed, files_seen FROM scans ORDER BY id DESC LIMIT 1")).toEqual([{ completed: 1, files_seen: 3 }]);
  }, 120_000);

  it("Rescan picks up new files and clears the request; a paused source ignores it until Resume", async () => {
    start();
    const dir = await folderWith("Tenders", 2);
    const s = addRegistrySource(registry, { kind: "folder", name: "Tenders", config: { path: dir } });
    await until(() => ready(s.id) === 2, "2 ready");

    await makePdf(path.join(dir, "late-1.pdf"), [{ lines: [`${LONG} late one`] }], work);
    requestRescan(registry, s.id);
    await until(() => ready(s.id) === 3, "the new file after Rescan");
    await until(() => getRegistrySource(registry, s.id)!.rescanRequestedAt === null, "the request cleared");

    setSourceState(registry, s.id, "paused");
    await makePdf(path.join(dir, "late-2.pdf"), [{ lines: [`${LONG} late two`] }], work);
    requestRescan(registry, s.id);
    await new Promise((r) => setTimeout(r, 600));
    expect(ready(s.id)).toBe(3); // paused: not scanned, search still serves what's there
    expect(getRegistrySource(registry, s.id)!.rescanRequestedAt).not.toBeNull();
    setSourceState(registry, s.id, "active");
    await until(() => ready(s.id) === 4, "the file after Resume");
  }, 180_000);

  it("Pause stops that source mid-run (in-flight files released, temp files gone, nothing claimed); Resume finishes it, each file exactly once", async () => {
    start({ filesInFlight: 2 });
    const dir = await folderWith("Big", 8);
    const s = addRegistrySource(registry, { kind: "folder", name: "Big", config: { path: dir } });
    await until(() => ready(s.id) >= 2, "two documents done");
    setSourceState(registry, s.id, "paused");
    await new Promise((r) => setTimeout(r, 700));

    const atPause = ready(s.id);
    expect(atPause).toBeLessThan(8);
    expect(count("SELECT count(*) FROM jobs WHERE state = 'running'")).toBe(0);
    expect(fs.readdirSync(guard.paths.tmp).filter((n) => n.startsWith("file-"))).toEqual([]);
    await new Promise((r) => setTimeout(r, 500));
    expect(ready(s.id)).toBe(atPause); // nothing is claimed while paused

    setSourceState(registry, s.id, "active");
    await until(() => ready(s.id) === 8, "all 8 ready after Resume");
    // Exactly once: 2 pages x 8 files, each page's two readings (text + OCR) -- no duplicates from the interrupted files.
    expect(count("SELECT count(*) FROM documents WHERE source_id = ?", s.id)).toBe(8);
    expect(count("SELECT count(*) FROM texts")).toBe(count("SELECT count(*) FROM texts_exact_docsize"));
    expect(count("SELECT count(*) FROM jobs")).toBe(0);
    expect(q("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }, 180_000);

  it("Remove deletes that source's index entries only: the other source and the original files are untouched, the registry row goes, the ordinal is never reused", async () => {
    start();
    const a = await folderWith("Alpha", 2);
    const b = await folderWith("Beta", 3);
    const sa = addRegistrySource(registry, { kind: "folder", name: "Alpha", config: { path: a } });
    const sb = addRegistrySource(registry, { kind: "folder", name: "Beta", config: { path: b } });
    await until(() => ready(sa.id) === 2 && ready(sb.id) === 3, "both sources ready");
    expect(q("SELECT name, ordinal FROM sources ORDER BY ordinal")).toEqual([{ name: "Alpha", ordinal: 1 }, { name: "Beta", ordinal: 2 }]);

    const alphaTextsBefore = count("SELECT count(*) FROM texts WHERE id BETWEEN ? AND ?", 1 * 2 ** 24 * 2 ** 21, 2 * 2 ** 24 * 2 ** 21 - 1);
    const ocrBefore = Number(new Database(guard.paths.ocrCache, { readonly: true }).prepare("SELECT count(*) FROM ocr").pluck().get());
    const originals = { alpha: snapshotTree(a), beta: snapshotTree(b) };

    setSourceState(registry, sb.id, "removing");
    await until(() => getRegistrySource(registry, sb.id) === null, "Beta's registry row to go");

    expect(count("SELECT count(*) FROM documents WHERE source_id = ?", sb.id)).toBe(0);
    expect(count("SELECT count(*) FROM documents WHERE source_id = ?", sa.id)).toBe(2);
    expect(count("SELECT count(*) FROM texts")).toBe(alphaTextsBefore);
    expect(count("SELECT count(*) FROM texts_exact_docsize")).toBe(alphaTextsBefore);
    expect(count("SELECT count(*) FROM jobs WHERE source_id = ?", sb.id)).toBe(0);
    expect(q("SELECT id FROM sources")).toEqual([{ id: sa.id }]);
    // Its cached OCR text went with it (nothing else uses those files); Alpha's stayed.
    const ocrAfter = Number(new Database(guard.paths.ocrCache, { readonly: true }).prepare("SELECT count(*) FROM ocr").pluck().get());
    expect(ocrAfter).toBeLessThan(ocrBefore);
    expect(ocrAfter).toBeGreaterThan(0);
    // The files themselves: byte-identical, nothing added.
    expect(snapshotTree(a)).toEqual(originals.alpha);
    expect(snapshotTree(b)).toEqual(originals.beta);

    // A new source does NOT inherit Beta's id range.
    const c = await folderWith("Gamma", 1);
    const sc = addRegistrySource(registry, { kind: "folder", name: "Gamma", config: { path: c } });
    await until(() => ready(sc.id) === 1, "Gamma ready");
    expect(q("SELECT ordinal FROM sources WHERE id = ?", sc.id)).toEqual([{ ordinal: 3 }]);
    expect(q("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  }, 240_000);

  it("settings that stop working become an error on that source (and clear when fixed); nothing crashes", async () => {
    start();
    const dir = await folderWith("Tenders", 1);
    const s = addRegistrySource(registry, { kind: "folder", name: "Tenders", config: { path: dir } });
    await until(() => ready(s.id) === 1, "ready");

    updateSourceConfig(registry, s.id, { path: path.join(roots, "NotThere") });
    await until(() => q<{ last_error: string | null }>("SELECT last_error FROM sources")[0].last_error !== null, "an error to be recorded");
    expect(q<{ last_error: string }>("SELECT last_error FROM sources")[0].last_error).toBe("The folder wasn't found. If it's on a drive, is the drive connected?");
    expect(ready(s.id)).toBe(1); // what was indexed is still searchable

    updateSourceConfig(registry, s.id, { path: dir });
    await until(() => q<{ last_error: string | null }>("SELECT last_error FROM sources")[0].last_error === null, "the error to clear");

    updateSourceConfig(registry, s.id, { path: os.tmpdir() }); // outside the allowed root
    await until(() => q<{ last_error: string | null }>("SELECT last_error FROM sources")[0].last_error !== null, "a not-allowed error");
    expect(q<{ last_error: string }>("SELECT last_error FROM sources")[0].last_error).toMatch(/no longer inside an allowed location/);
  }, 180_000);

  it("the storage limit pauses the service and says so in its status; Remove still works while paused (it's how space is freed); it resumes by itself", async () => {
    start();
    const a = await folderWith("Alpha", 2);
    const sa = addRegistrySource(registry, { kind: "folder", name: "Alpha", config: { path: a } });
    await until(() => ready(sa.id) === 2, "Alpha ready");

    guard.cap = 1000;
    guard.used = 5000;
    await until(() => JSON.parse(q<{ value: string }>("SELECT value FROM meta WHERE key = 'worker_status'")[0].value).state === "paused: storage limit", "the status to say paused");
    const status = JSON.parse(q<{ value: string }>("SELECT value FROM meta WHERE key = 'worker_status'")[0].value);
    expect(status.limit.kind).toBe("cap");
    expect(status.limit.message).toMatch(/^Paused: storage limit\./);
    expect(status.usedBytes).toBe(5000);
    expect(ready(sa.id)).toBe(2); // nothing deleted by the pause

    // A new file isn't picked up while paused...
    await makePdf(path.join(a, "while-paused.pdf"), [{ lines: [`${LONG} while paused`] }], work);
    requestRescan(registry, sa.id);
    await new Promise((r) => setTimeout(r, 500));
    expect(ready(sa.id)).toBe(2);
    // ...but removing a source still goes through.
    setSourceState(registry, sa.id, "removing");
    await until(() => getRegistrySource(registry, sa.id) === null, "removal during the pause");
    expect(count("SELECT count(*) FROM documents")).toBe(0);

    guard.used = 0;
    await until(() => JSON.parse(q<{ value: string }>("SELECT value FROM meta WHERE key = 'worker_status'")[0].value).state === "running", "back to running");
  }, 180_000);
});

describe.skipIf(skipOcr)("a Google Drive source through the service (mocked Drive API)", () => {
  let drive: MockDrive | null = null;
  afterEach(async () => {
    await drive?.close();
    drive = null;
  });

  async function pdf(text: string): Promise<Buffer> {
    const file = path.join(work, `${Math.random().toString(36).slice(2)}.pdf`);
    await makePdf(file, [{ lines: [`${LONG} ${text}`] }, { lines: [`second page ${text}`] }], work);
    return fs.readFileSync(file);
  }

  it("downloads each PDF, indexes it, deletes it at once; unchanged files aren't downloaded again; a rename costs no download; deletions are swept", async () => {
    const ROOT = "DRIVEROOTFOLDER0001";
    drive = await startMockDrive([
      { id: ROOT, name: "BHEL tenders", mimeType: FOLDER_MIME, parent: null },
      { id: "fa", name: "a-notice.pdf", parent: ROOT, content: await pdf("alpha"), modifiedTime: "2026-01-01T00:00:00.000Z" },
      { id: "sub", name: "Sub", mimeType: FOLDER_MIME, parent: ROOT },
      { id: "fb", name: "b-spec.pdf", parent: "sub", content: await pdf("bravo"), modifiedTime: "2026-01-01T00:00:00.000Z" },
      { id: "fc", name: "c-gone.pdf", parent: ROOT, content: await pdf("charlie"), modifiedTime: "2026-01-01T00:00:00.000Z" },
    ]);
    start({}, { GOOGLE_API_KEY: drive.apiKey, GOOGLE_DRIVE_API_BASE: drive.base });
    const s = addRegistrySource(registry, { kind: "drive", name: "BHEL tenders", config: { folderId: ROOT, link: `https://drive.google.com/drive/folders/${ROOT}` } });
    await until(() => ready(s.id) === 3, "3 Drive files indexed");

    expect(q("SELECT display_name FROM documents").map((r) => (r as { display_name: string }).display_name).sort()).toEqual(["Sub/b-spec.pdf", "a-notice.pdf", "c-gone.pdf"]);
    expect(q("SELECT kind FROM sources")).toEqual([{ kind: "drive" }]);
    await until(() => fs.readdirSync(guard.paths.tmp).length === 0, "every download to be deleted");
    const downloads = () => drive!.requests.filter((r) => r.endsWith("?alt=media")).length;
    expect(downloads()).toBe(3);

    // Rescan with nothing changed: nothing is downloaded.
    requestRescan(registry, s.id);
    await until(() => getRegistrySource(registry, s.id)!.rescanRequestedAt === null, "the rescan to start");
    await new Promise((r) => setTimeout(r, 800));
    expect(downloads()).toBe(3);

    // One file changes (new content, new modifiedTime), one is renamed (same content and time), one is deleted.
    const changed = drive.files.find((f) => f.id === "fa")!;
    changed.content = await pdf("alpha revised with brand new wording");
    changed.modifiedTime = "2026-03-01T00:00:00.000Z";
    drive.files.find((f) => f.id === "fb")!.name = "b-renamed.pdf";
    drive.files.splice(drive.files.findIndex((f) => f.id === "fc"), 1);
    requestRescan(registry, s.id);
    await until(() => q("SELECT display_name FROM documents").map((r) => (r as { display_name: string }).display_name).sort().join("|") === "Sub/b-renamed.pdf|a-notice.pdf", "rename + delete applied");
    await until(() => downloads() === 4, "only the changed file downloaded again");
    await until(() => count("SELECT count(*) FROM texts_exact WHERE texts_exact MATCH '\"brand new wording\"'") === 1, "the revised text searchable");
    expect(downloads()).toBe(4); // the rename and the unchanged file cost no download
    await until(() => fs.readdirSync(guard.paths.tmp).length === 0, "the temp folder to be empty");
  }, 240_000);

  it("a private folder is a plain-language error on the source, not a crash", async () => {
    const ROOT = "DRIVEROOTFOLDER0002";
    drive = await startMockDrive([{ id: ROOT, name: "Private", mimeType: FOLDER_MIME, parent: null }]);
    drive.makePrivate(404);
    start({}, { GOOGLE_API_KEY: drive.apiKey, GOOGLE_DRIVE_API_BASE: drive.base });
    addRegistrySource(registry, { kind: "drive", name: "Private", config: { folderId: ROOT, link: "x" } });
    await until(() => (q<{ last_error: string | null }>("SELECT last_error FROM sources")[0]?.last_error ?? null) !== null, "an error on the source");
    expect(q<{ last_error: string }>("SELECT last_error FROM sources")[0].last_error).toContain("Private folders aren't supported yet");
  }, 120_000);
});

describe("the .env source", () => {
  it("LOCUS_LIBRARY_DIR appears as a source managed in .env: pausable, not removable; when it leaves .env it becomes an ordinary source", () => {
    const dir = path.join(roots, "FromEnv");
    fs.mkdirSync(dir, { recursive: true });
    const config = loadLibraryConfig({ LOCUS_DATA_DIR: data, LOCUS_LIBRARY_DIR: dir, LOCUS_ALLOWED_ROOTS: roots });
    registry = openRegistry(path.join(data, "sources.db"));
    syncEnvSources(registry, config);
    syncEnvSources(registry, config); // idempotent
    const [env] = listRegistry(registry);
    expect(listRegistry(registry)).toHaveLength(1);
    expect(env).toMatchObject({ kind: "folder", name: "FromEnv", managedBy: "env", state: "active", config: { path: dir } });
    setSourceState(registry, env.id, "paused");
    expect(() => setSourceState(registry, env.id, "removing")).toThrowError(expect.objectContaining({ code: "managed-by-env" }));

    syncEnvSources(registry, loadLibraryConfig({ LOCUS_DATA_DIR: data, LOCUS_ALLOWED_ROOTS: roots }));
    expect(getRegistrySource(registry, env.id)!.managedBy).toBe("app");
    setSourceState(registry, env.id, "removing"); // now it can go
    expect(getRegistrySource(registry, env.id)!.state).toBe("removing");
  });

  it("a name already taken gets a '(.env)' suffix instead of failing", () => {
    const dir = path.join(roots, "Tenders");
    fs.mkdirSync(dir, { recursive: true });
    registry = openRegistry(path.join(data, "sources.db"));
    addRegistrySource(registry, { kind: "folder", name: "tenders", config: { path: path.join(roots, "Other") } });
    syncEnvSources(registry, loadLibraryConfig({ LOCUS_DATA_DIR: data, LOCUS_LIBRARY_DIR: dir, LOCUS_ALLOWED_ROOTS: roots }));
    expect(listRegistry(registry).map((s) => s.name).sort()).toEqual(["Tenders (.env)", "tenders"]);
  });
});
