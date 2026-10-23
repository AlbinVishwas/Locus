import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXCLUDES, DEFAULT_INCLUDES } from "./config";
import { walk, type SkipRecord, type WalkFile, type WalkOptions } from "./walk";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "locus-walk-"));
});

afterEach(() => {
  // Undo chmod 000 so the tree can be removed.
  execFileSync("chmod", ["-R", "u+rwx", root]);
  // rm(1), not fs.rmSync: it can remove the over-PATH_MAX tree one test builds.
  execFileSync("rm", ["-rf", root]);
  vi.restoreAllMocks();
  // Removing the 60,000-file tree takes a while on a busy machine.
}, 60_000);

function touch(rel: string, content = "%PDF-1.4\n") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function collect(extra: Partial<WalkOptions> = {}) {
  const skips: SkipRecord[] = [];
  const others: Array<[string, number | null]> = [];
  const excluded: string[] = [];
  const files: WalkFile[] = [];
  for await (const f of walk(root, {
    include: DEFAULT_INCLUDES,
    exclude: DEFAULT_EXCLUDES,
    onSkip: (s) => skips.push(s),
    onOther: (ext, size) => others.push([ext, size]),
    onExcluded: (rel) => excluded.push(rel),
    ...extra,
  })) {
    files.push(f);
  }
  return { files, skips, others, excluded };
}

describe("walk", () => {
  it("yields only PDFs (any case), counts everything else, and skips excluded folders and temp files", async () => {
    touch("a.pdf");
    touch("Sub/B.PDF");
    touch("Sub/deeper/c.Pdf");
    touch("notes.txt", "hello");
    touch("Sub/photo.JPG", "x");
    touch("Sub/archive.zip", "x");
    touch("Sub/half.pdf.part", "x");
    touch("Sub/~$lock.pdf");
    touch(".Trashes/deleted.pdf");
    touch("$RECYCLE.BIN/old.pdf");
    touch("System Volume Information/x.pdf");
    touch(".hidden/h.pdf");

    const { files, others, excluded, skips } = await collect();
    expect(files.map((f) => f.relPath).sort()).toEqual(["Sub/B.PDF", "Sub/deeper/c.Pdf", "a.pdf"]);
    expect(others.map(([e]) => e).sort()).toEqual(["jpg", "txt"]);
    expect(excluded.sort()).toEqual([
      ".Trashes",
      ".hidden",
      "$RECYCLE.BIN",
      "Sub/archive.zip",
      "Sub/half.pdf.part",
      "Sub/~$lock.pdf",
      "System Volume Information",
    ].sort());
    expect(skips).toEqual([]);
    // Excluded folders are never descended into.
    expect(files.some((f) => f.relPath.startsWith(".Trashes"))).toBe(false);
  });

  it("include/exclude patterns are configurable", async () => {
    touch("keep/a.pdf");
    touch("drop/b.pdf");
    touch("keep/c.pdf");
    const { files } = await collect({ include: ["keep/**/*.pdf"], exclude: ["**/c.pdf"] });
    expect(files.map((f) => f.relPath)).toEqual(["keep/a.pdf"]);
  });

  it("reports others' sizes only when asked (the inventory), without stat'ing them otherwise", async () => {
    touch("big.bin", "x".repeat(1234));
    expect((await collect()).others).toEqual([["bin", null]]);
    expect((await collect({ statOthers: true })).others).toEqual([["bin", 1234]]);
  });

  it("never follows symlinks, so a symlink loop is just a skipped entry", async () => {
    touch("real/a.pdf");
    fs.symlinkSync("..", path.join(root, "real", "loop"));
    fs.symlinkSync(path.join(root, "real", "a.pdf"), path.join(root, "link.pdf"));
    const { files, skips } = await collect();
    expect(files.map((f) => f.relPath)).toEqual(["real/a.pdf"]);
    expect(skips.map((s) => [s.relPath, s.reason]).sort()).toEqual([
      ["link.pdf", "symlink"],
      ["real/loop", "symlink"],
    ]);
  });

  it("logs a permission-denied folder and carries on", async () => {
    touch("locked/secret.pdf");
    touch("open/fine.pdf");
    fs.chmodSync(path.join(root, "locked"), 0o000);
    const { files, skips } = await collect();
    expect(files.map((f) => f.relPath)).toEqual(["open/fine.pdf"]);
    expect(skips).toEqual([
      expect.objectContaining({ relPath: "locked", reason: "permission-denied", isDirectory: true }),
    ]);
  });

  it("logs a path too long to open and carries on", async () => {
    touch("ok.pdf");
    // Build past PATH_MAX (1024 bytes) one relative mkdir at a time.
    const segment = "d".repeat(200);
    let rel = "long";
    fs.mkdirSync(path.join(root, rel));
    for (let i = 0; i < 6; i++) {
      execFileSync("sh", ["-c", `cd "${rel}" && mkdir "${segment}"`], { cwd: root });
      rel = `${rel}/${segment}`;
    }
    const { files, skips } = await collect();
    expect(files.map((f) => f.relPath)).toEqual(["ok.pdf"]);
    expect(skips.some((s) => s.reason === "path-too-long")).toBe(true);
  });

  it("handles non-English, NFD, emoji and punctuation-heavy names: NFC keys, openable raw paths", async () => {
    const names = ["दस्तावेज़.pdf", "Résumé.pdf", "📄 report.pdf", `it's "odd" (v2) [final] #1 & co.pdf`, "中文 文件.pdf"];
    for (const n of names) touch(n);
    const { files, skips } = await collect();
    expect(skips).toEqual([]);
    expect(files.map((f) => f.relPath).sort()).toEqual(names.map((n) => n.normalize("NFC")).sort());
    for (const f of files) {
      expect(fs.readFileSync(f.absPath, "utf8")).toBe("%PDF-1.4\n");
    }
  });

  it("a file that disappears mid-walk is logged as vanished", async () => {
    touch("dir/x.pdf");
    touch("dir/y.pdf");
    const skips: SkipRecord[] = [];
    const seen: string[] = [];
    for await (const f of walk(root, { include: DEFAULT_INCLUDES, exclude: [], onSkip: (s) => skips.push(s) })) {
      seen.push(f.relPath);
      // Both entries were already listed; delete the one not yet yielded.
      const other = f.relPath === "dir/x.pdf" ? "dir/y.pdf" : "dir/x.pdf";
      fs.rmSync(path.join(root, other), { force: true });
    }
    expect(seen).toHaveLength(1);
    expect(skips).toEqual([expect.objectContaining({ reason: "vanished", isDirectory: false })]);
  });

  it("a missing root is reported, not thrown", async () => {
    const skips: SkipRecord[] = [];
    for await (const f of walk(path.join(root, "nope"), { include: DEFAULT_INCLUDES, exclude: [], onSkip: (s) => skips.push(s) })) {
      void f;
    }
    expect(skips).toEqual([expect.objectContaining({ relPath: "", reason: "vanished" })]);
  });

  it("detects a directory cycle by device+inode (a firmlink/hard-linked dir can't be made on APFS, so lstat is faked)", async () => {
    touch("a/b/x.pdf");
    const real = fs.promises.lstat;
    const rootStat = fs.lstatSync(root);
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (p, ...rest) => {
      if (String(p).endsWith(`${path.sep}b`)) return rootStat as fs.Stats;
      return real(p, ...(rest as []));
    });
    const { files, skips } = await collect();
    expect(files).toEqual([]);
    expect(skips).toEqual([expect.objectContaining({ relPath: "a/b", reason: "directory-cycle" })]);
  });

  it("doesn't cross into another device unless asked", async () => {
    touch("mnt/x.pdf");
    const real = fs.promises.lstat;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (p, ...rest) => {
      const s = await real(p, ...(rest as []));
      if (String(p).endsWith(`${path.sep}mnt`)) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { dev: s.dev + 1 });
      return s;
    });
    expect((await collect()).skips).toEqual([expect.objectContaining({ relPath: "mnt", reason: "other-device" })]);
    expect((await collect({ crossDevice: true })).files.map((f) => f.relPath)).toEqual(["mnt/x.pdf"]);
  });

  it("stops promptly on abort and closes every open directory", async () => {
    for (let i = 0; i < 50; i++) touch(`d${i}/f.pdf`);
    const ac = new AbortController();
    let n = 0;
    for await (const f of walk(root, { include: DEFAULT_INCLUDES, exclude: [], onSkip: () => {}, signal: ac.signal })) {
      void f;
      if (++n === 3) ac.abort();
    }
    expect(n).toBe(3);
  });

  it("skipDir prunes a subtree and onDirDone fires once per finished directory", async () => {
    touch("a/1.pdf");
    touch("b/2.pdf");
    touch("b/c/3.pdf");
    const done: string[] = [];
    const { files } = await collect({ skipDir: (rel) => rel === "a", onDirDone: (rel) => done.push(rel) });
    expect(files.map((f) => f.relPath).sort()).toEqual(["b/2.pdf", "b/c/3.pdf"]);
    expect(done.sort()).toEqual(["", "b", "b/c"]);
  });

  it("uses constant memory: 60,000 files, heap stays flat", async () => {
    const flat = path.join(root, "flat");
    fs.mkdirSync(flat);
    for (let i = 0; i < 50_000; i++) fs.writeFileSync(path.join(flat, `f${i}.${i % 5 === 0 ? "pdf" : "dat"}`), "");
    for (let d = 0; d < 100; d++) {
      const sub = path.join(root, "nested", `n${d}`);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(sub, `g${i}.pdf`), "");
    }
    globalThis.gc?.();
    const base = process.memoryUsage().heapUsed;
    let peak = base;
    let pdfs = 0;
    let others = 0;
    for await (const f of walk(root, { include: DEFAULT_INCLUDES, exclude: [], onSkip: () => {}, onOther: () => others++ })) {
      void f;
      if (++pdfs % 1000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    expect(pdfs).toBe(10_000 + 10_000);
    expect(others).toBe(40_000);
    // Holding 60k paths and stats would take tens of MB; streaming stays
    // within GC noise.
    expect(peak - base).toBeLessThan(40 * 1024 * 1024);
  }, 120_000);
});
