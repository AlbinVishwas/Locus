import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLibraryConfig } from "./config";
import { BROWSE_LIMIT, browseFolders, isWithin, resolveAllowed } from "./allowedRoots";

let base: string;
let root: string;
let outside: string;
let dataDir: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "locus-roots-")));
  root = path.join(base, "Volumes");
  outside = path.join(base, "Secrets");
  dataDir = path.join(base, "locus-data");
  for (const d of [root, outside, dataDir]) fs.mkdirSync(d);
  fs.mkdirSync(path.join(root, "Archive", "Tenders"), { recursive: true });
  fs.writeFileSync(path.join(root, "Archive", "note.txt"), "x");
  fs.writeFileSync(path.join(outside, "passwords.pdf"), "%PDF-1.4");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const opts = () => ({ roots: [root], dataDir });
const refusal = (input: unknown, o = opts()) => {
  const r = resolveAllowed(input, o);
  return r.ok ? "OK" : r.reason;
};

describe("resolveAllowed", () => {
  it("accepts the root itself and anything below it, returning the real path", () => {
    expect(resolveAllowed(root, opts())).toEqual({ ok: true, real: root });
    expect(resolveAllowed(path.join(root, "Archive", "Tenders"), opts())).toEqual({ ok: true, real: path.join(root, "Archive", "Tenders") });
    expect(resolveAllowed(path.join(root, "Archive", "Tenders") + "/", opts()).ok).toBe(true);
  });

  it("refuses anything outside, with a message that names what IS allowed", () => {
    const r = resolveAllowed(outside, opts());
    expect(r).toMatchObject({ ok: false, reason: "outside" });
    if (!r.ok) expect(r.message).toBe(`That location isn't allowed. Locus can only read from: ${root}.`);
    expect(refusal("/etc")).toBe("outside");
    expect(refusal(os.homedir())).toBe("outside");
  });

  it("empty, NUL, relative and '..' are refused before the filesystem is touched", () => {
    expect(refusal("")).toBe("empty");
    expect(refusal("   ")).toBe("empty");
    expect(refusal(undefined)).toBe("empty");
    expect(refusal(42)).toBe("empty");
    expect(refusal(`${root}/Archive\0/../../Secrets`)).toBe("nul");
    expect(refusal("Archive/Tenders")).toBe("relative");
    expect(refusal("./Volumes")).toBe("relative");
    expect(refusal(`${root}/Archive/../../Secrets`)).toBe("dotdot");
    expect(refusal(`${root}/..`)).toBe("dotdot");
  });

  it("a look-alike prefix is not 'inside' (/VolumesX vs /Volumes)", () => {
    const lookalike = root + "X";
    fs.mkdirSync(lookalike);
    expect(refusal(lookalike)).toBe("outside");
    expect(isWithin(lookalike, root)).toBe(false);
    expect(isWithin(path.join(root, "a"), root)).toBe(true);
    expect(isWithin(root, root)).toBe(true);
  });

  it("a symlink inside an allowed root that points outside is refused (it resolves to its real target)", () => {
    fs.symlinkSync(outside, path.join(root, "innocent-looking"));
    expect(refusal(path.join(root, "innocent-looking"))).toBe("outside");
    // And one that stays inside is fine, reported by its real path.
    fs.symlinkSync(path.join(root, "Archive"), path.join(root, "shortcut"));
    expect(resolveAllowed(path.join(root, "shortcut"), opts())).toEqual({ ok: true, real: path.join(root, "Archive") });
  });

  it("a folder that contains Locus's data folder, or sits inside it, is refused", () => {
    const inside = { roots: [base], dataDir };
    expect(refusal(base, inside)).toBe("contains-data-dir");
    expect(refusal(dataDir, inside)).toBe("inside-data-dir");
    fs.mkdirSync(path.join(dataDir, "library"));
    expect(refusal(path.join(dataDir, "library"), inside)).toBe("inside-data-dir");
  });

  it("missing and not-a-folder / not-a-file", () => {
    expect(refusal(path.join(root, "nope"))).toBe("missing");
    expect(refusal(path.join(root, "Archive", "note.txt"))).toBe("not-a-folder");
    expect(resolveAllowed(path.join(root, "Archive", "note.txt"), { ...opts(), want: "file" }).ok).toBe(true);
    expect(refusal(path.join(root, "Archive"), { ...opts(), want: "file" } as never)).toBe("not-a-file");
  });

  it("accented names, in either Unicode form, resolve (macOS stores them decomposed)", () => {
    const nfd = "Résumé";
    fs.mkdirSync(path.join(root, nfd));
    const nfc = nfd.normalize("NFC");
    expect(resolveAllowed(path.join(root, nfc), opts()).ok).toBe(true);
    expect(resolveAllowed(path.join(root, nfd), opts()).ok).toBe(true);
  });

  it("an unreadable folder is reported, not thrown", () => {
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.mkdirSync(path.join(locked, "inner"));
    fs.chmodSync(locked, 0o000);
    try {
      const r = resolveAllowed(path.join(locked, "inner"), opts());
      expect(r.ok).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("roots are case-insensitive on macOS (a volume is reachable as /volumes too)", () => {
    if (process.platform !== "darwin") return;
    expect(isWithin("/volumes/x", "/Volumes")).toBe(true);
  });

  it("config refuses '/' as an allowed root", () => {
    expect(() => loadLibraryConfig({ LOCUS_ALLOWED_ROOTS: "/" })).toThrow(/every folder on this Mac/);
    expect(() => loadLibraryConfig({ LOCUS_ALLOWED_ROOTS: "/Volumes,/" })).toThrow();
  });
});

describe("browseFolders", () => {
  it("with no path: lists the allowed roots (and only those)", () => {
    const r = browseFolders(null, opts());
    expect(r).toMatchObject({ ok: true, path: null, parent: null, crumbs: [] });
    if (r.ok) expect(r.entries.map((e) => e.path)).toEqual([root]);
  });

  it("lists sub-folders only: no files, no hidden folders; with a breadcrumb that starts at the root and a parent to go up to", () => {
    fs.mkdirSync(path.join(root, "Archive", ".hidden"));
    fs.mkdirSync(path.join(root, "Archive", "2025"));
    const r = browseFolders(path.join(root, "Archive"), opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).toEqual(["2025", "Tenders"]);
    expect(r.crumbs.map((c) => c.name)).toEqual([root, "Archive"]);
    expect(r.parent).toBe(root);
    expect(r.entries.every((e) => e.readable && path.isAbsolute(e.path))).toBe(true);
  });

  it("can't go above an allowed root", () => {
    const r = browseFolders(root, opts());
    if (r.ok) expect(r.parent).toBeNull();
    expect(browseFolders(base, opts())).toMatchObject({ ok: false, reason: "outside" });
    expect(browseFolders(`${root}/../Secrets`, opts())).toMatchObject({ ok: false, reason: "dotdot" });
  });

  it("doesn't offer a symlink that leads outside, or Locus's own data folder", () => {
    fs.symlinkSync(outside, path.join(root, "escape"));
    const inside = { roots: [base], dataDir };
    const r = browseFolders(base, inside);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries.map((e) => e.name)).not.toContain("locus-data");
      expect(r.entries.map((e) => e.name)).toContain("Volumes");
    }
    const inRoot = browseFolders(root, opts());
    if (inRoot.ok) expect(inRoot.entries.map((e) => e.name)).not.toContain("escape");
  });

  it("caps the listing and says so", () => {
    for (let i = 0; i < BROWSE_LIMIT + 5; i++) fs.mkdirSync(path.join(root, `d${String(i).padStart(5, "0")}`));
    const r = browseFolders(root, opts());
    expect(r.ok && r.entries.length).toBe(BROWSE_LIMIT);
    expect(r.ok && r.truncated).toBe(true);
  });
});
