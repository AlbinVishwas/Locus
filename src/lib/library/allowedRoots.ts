import fs from "node:fs";
import path from "node:path";
import { appDir } from "../appDir";

/**
 * Which folders Locus may read when someone adds a source. The Sources page
 * is reachable over the internet, so without this a stolen admin passcode
 * could point the indexer at any folder on the Mac. The default allowed root
 * is /Volumes (external and connected drives); LOCUS_ALLOWED_ROOTS adds more.
 *
 * `resolveAllowed` is the one check, used by every entry point that takes a
 * path -- the folder browser, Test, Add, Edit, a database's file paths, and
 * the indexer itself at the start of every scan. It runs on the server; the
 * browser's idea of a path is never trusted.
 */

/**
 * Locus's own files besides the library's data folder: the records database (accounts, activity), everyone's
 * uploads, and the session search index. A source may never contain or sit inside these, whatever the allowed
 * roots say: with accounts, that would let one person index another's files.
 */
function ownDirs(): string[] {
  const index = process.env.SEARCH_INDEX_PATH?.trim();
  const records = process.env.LOCUS_APP_DB_PATH?.trim();
  return [
    appDir(),
    process.env.UPLOADS_DIR?.trim() || path.join(process.cwd(), "data/uploads"),
    index ? path.dirname(path.resolve(index)) : path.join(process.cwd(), "data/index"),
    ...(records ? [path.dirname(path.resolve(records))] : []),
  ];
}

export type RootRefusal =
  | "empty"
  | "nul"
  | "relative"
  | "dotdot"
  | "missing"
  | "no-access"
  | "not-a-folder"
  | "not-a-file"
  | "outside"
  | "contains-data-dir"
  | "inside-data-dir";

export type RootCheck = { ok: true; real: string } | { ok: false; reason: RootRefusal; message: string };

export interface RootOptions {
  roots: string[];
  /** The library's own data folder: a source may not contain it or live inside it. */
  dataDir?: string;
  /** What the path must be. Default: a folder. */
  want?: "folder" | "file";
}

// macOS volumes are case-insensitive by default, and /volumes/x reaches /Volumes/x.
const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Whether `child` is `parent` or lies below it, compared by whole path segments (so /VolumesX is not under /Volumes). */
export function isWithin(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

export function allowedList(roots: string[]): string {
  return roots.length === 0 ? "nothing (LOCUS_ALLOWED_ROOTS is empty)" : roots.join(", ");
}

export function resolveAllowed(input: unknown, options: RootOptions): RootCheck {
  const refuse = (reason: RootRefusal, message: string): RootCheck => ({ ok: false, reason, message });
  if (typeof input !== "string" || input.trim() === "") return refuse("empty", "Enter a path.");
  const raw = input.trim();
  if (raw.includes("\0")) return refuse("nul", "That path isn't valid.");
  if (!path.isAbsolute(raw)) return refuse("relative", "Enter the full path, starting with /.");
  // Before touching the filesystem: no climbing out of anywhere.
  if (raw.split(path.sep).includes("..")) return refuse("dotdot", "Paths can't contain '..'.");

  let real: string;
  try {
    real = fs.realpathSync.native(raw.normalize("NFC"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // NFD paths (how macOS stores accented names) need the raw spelling.
    if (code === "ENOENT") {
      const second = realOrNull(raw);
      if (second === null) return refuse("missing", "That path was not found.");
      real = second;
    } else if (code === "EACCES" || code === "EPERM") {
      return refuse("no-access", "Locus can't read that location (permission denied).");
    } else {
      return refuse("missing", "That path was not found.");
    }
  }

  const roots = options.roots.map((r) => realOrNull(r) ?? path.resolve(r));
  if (!roots.some((r) => isWithin(real, r))) {
    return refuse("outside", `That location isn't allowed. Locus can only read from: ${allowedList(options.roots)}.`);
  }

  if (options.dataDir) {
    const data = realOrNull(options.dataDir) ?? path.resolve(options.dataDir);
    if (isWithin(real, data)) return refuse("inside-data-dir", "That's inside Locus's own data folder.");
    if (isWithin(data, real)) return refuse("contains-data-dir", "That folder contains Locus's own data folder, so it would index its own files.");
  }

  for (const own of ownDirs()) {
    const dir = realOrNull(own) ?? path.resolve(own);
    if (isWithin(real, dir) || isWithin(dir, real)) return refuse("inside-data-dir", "That location holds Locus's own files (accounts, uploads or the search index), so it can't be a source.");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return refuse("no-access", "Locus can't read that location.");
  }
  const want = options.want ?? "folder";
  if (want === "folder" && !stat.isDirectory()) return refuse("not-a-folder", "That's not a folder.");
  if (want === "file" && !stat.isFile()) return refuse("not-a-file", "That's not a file.");
  return { ok: true, real };
}

// --- the folder browser -------------------------------------------------------

export interface BrowseEntry {
  name: string;
  path: string;
  readable: boolean;
}

export interface BrowseResult {
  /** Where we are; null = the list of allowed roots. */
  path: string | null;
  /** The parent to go up to; null at the top (a root can't be left). */
  parent: string | null;
  /** Each part of `path` as a breadcrumb, from the allowed root down. */
  crumbs: Array<{ name: string; path: string }>;
  entries: BrowseEntry[];
  /** More folders than the 1,000 shown. */
  truncated: boolean;
}

export const BROWSE_LIMIT = 1000;

export type BrowseOutcome = ({ ok: true } & BrowseResult) | { ok: false; reason: RootRefusal; message: string };

/**
 * One level of the folder browser: folders only (never files, never hidden
 * folders), sorted, at most BROWSE_LIMIT, starting from the allowed roots
 * and never above them. `requested` is validated like any other path.
 */
export function browseFolders(requested: string | null, options: Omit<RootOptions, "want">): BrowseOutcome {
  if (requested === null || requested === "") {
    const entries: BrowseEntry[] = [];
    for (const root of options.roots) {
      const real = realOrNull(root);
      if (real === null) continue;
      entries.push({ name: root, path: real, readable: isReadableDir(real) });
    }
    return { ok: true, path: null, parent: null, crumbs: [], entries, truncated: false };
  }
  const checked = resolveAllowed(requested, { ...options, want: "folder" });
  // The browser may stand in the data folder's parent (to see its siblings) -- but resolveAllowed
  // refuses to *select* a folder containing it; for browsing only the "outside" refusal matters.
  if (!checked.ok && checked.reason !== "contains-data-dir") return checked;
  const real = checked.ok ? checked.real : (realOrNull(requested) ?? requested);

  const roots = options.roots.map((r) => realOrNull(r) ?? path.resolve(r));
  const root = roots.find((r) => isWithin(real, r))!;
  const crumbs: Array<{ name: string; path: string }> = [{ name: root, path: root }];
  const rel = path.relative(root, real);
  if (rel) {
    let cur = root;
    for (const part of rel.split(path.sep)) {
      cur = path.join(cur, part);
      crumbs.push({ name: part, path: cur });
    }
  }
  const parent = fold(real) === fold(root) ? null : path.dirname(real);

  const entries: BrowseEntry[] = [];
  let truncated = false;
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(real, { withFileTypes: true });
  } catch {
    return { ok: true, path: real, parent, crumbs, entries: [], truncated: false };
  }
  const data = options.dataDir ? (realOrNull(options.dataDir) ?? path.resolve(options.dataDir)) : null;
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }))) {
    if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const full = path.join(real, e.name);
    const target = realOrNull(full);
    if (target === null) continue;
    // A symlink to somewhere outside the allowed roots isn't offered at all.
    if (!roots.some((r) => isWithin(target, r))) continue;
    if (!fs.statSync(target).isDirectory()) continue;
    if (data && isWithin(target, data)) continue; // Locus's own data isn't a source
    if (entries.length >= BROWSE_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({ name: e.name, path: target, readable: isReadableDir(target) });
  }
  return { ok: true, path: real, parent, crumbs, entries, truncated };
}

function isReadableDir(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
