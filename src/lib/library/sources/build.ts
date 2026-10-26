import type Database from "better-sqlite3";
import { allowedList, resolveAllowed } from "../allowedRoots";
import type { LibraryConfig } from "../config";
import type { ServedSource } from "../pipeline";
import { buildQuery, buildUrl, FormError } from "./db/form";
import { DatabaseSource } from "./database";
import { DriveApi, DriveError, driveApiBase } from "./gdriveApi";
import { GoogleDriveSource } from "./gdrive";
import { FolderSource } from "./folder";
import type { DatabaseConfig, DriveConfig, FolderConfig } from "./forms";
import { readSourceSecret, type RegistrySource } from "./registry";
import { SecretError } from "./secrets";
import type { LibrarySource } from "./types";

/**
 * Registry row -> a source the indexer can run, or a plain-language reason
 * it can't be (which the Sources page shows as "Error: ..."). Everything that
 * depends on the outside world is re-checked here, on every build: the folder
 * is still inside an allowed root (a folder swapped for a symlink later is
 * caught), the database password still opens, the key is still set.
 */

export interface BuildContext {
  config: LibraryConfig;
  registry: Database.Database;
  env?: Record<string, string | undefined>;
}

const LIBRARY_KIND = { folder: "folder", database: "database", drive: "drive" } as const;

function served(entry: RegistrySource, source: LibrarySource | null, error: string | null): ServedSource {
  return {
    id: entry.id,
    kind: LIBRARY_KIND[entry.kind],
    name: entry.name,
    label: source?.label ?? `${entry.kind} ${entry.name}`,
    state: entry.state,
    rescanRequestedAt: entry.rescanRequestedAt,
    source,
    error,
  };
}

export function buildServedSource(entry: RegistrySource, ctx: BuildContext): ServedSource {
  try {
    switch (entry.kind) {
      case "folder":
        return buildFolder(entry, ctx);
      case "database":
        return buildDatabase(entry, ctx);
      case "drive":
        return buildDrive(entry, ctx);
    }
  } catch (err) {
    return served(entry, null, err instanceof Error ? err.message : String(err));
  }
}

function buildFolder(entry: RegistrySource, ctx: BuildContext): ServedSource {
  const cfg = entry.config as FolderConfig;
  // A folder set in .env by whoever runs the app is trusted to be where it is; one an admin typed into
  // the web page must be inside an allowed root. Both must keep clear of Locus's own data.
  const roots = entry.managedBy === "env" ? [cfg.path] : ctx.config.allowedRoots;
  const check = resolveAllowed(cfg.path, { roots, dataDir: ctx.config.dataDir });
  if (!check.ok) {
    const message =
      check.reason === "missing"
        ? "The folder wasn't found. If it's on a drive, is the drive connected?"
        : check.reason === "outside"
          ? `The folder is no longer inside an allowed location (${allowedList(ctx.config.allowedRoots)}).`
          : check.message;
    return served(entry, null, message);
  }
  const source = new FolderSource(check.real, {
    id: entry.id,
    name: entry.name,
    include: ctx.config.include,
    exclude: ctx.config.exclude,
    crossDevice: ctx.config.crossDevice,
    maxFileBytes: ctx.config.maxFileBytes,
    settleSeconds: ctx.config.settleSeconds,
  });
  return served(entry, source, null);
}

function buildDatabase(entry: RegistrySource, ctx: BuildContext): ServedSource {
  const cfg = entry.config as DatabaseConfig;
  let password: string | null = null;
  if (cfg.hasPassword) {
    try {
      password = readSourceSecret(ctx.registry, entry.id);
    } catch (err) {
      if (err instanceof SecretError) return served(entry, null, `Can't read the saved password: ${err.message}`);
      throw err;
    }
    if (password === null) return served(entry, null, "The saved password is missing. Edit the source and enter it again.");
  }
  let file = cfg.file;
  if (cfg.dialect === "sqlite") {
    const check = resolveAllowed(cfg.file, { roots: ctx.config.allowedRoots, dataDir: ctx.config.dataDir, want: "file" });
    if (!check.ok) return served(entry, null, `Database file: ${check.message}`);
    file = check.real;
  }
  let url: string;
  let query: string;
  try {
    url = buildUrl({ ...cfg, file }, password);
    query = buildQuery(cfg);
  } catch (err) {
    if (err instanceof FormError) return served(entry, null, err.message);
    throw err;
  }
  const source = new DatabaseSource(url, query, {
    id: entry.id,
    name: entry.name,
    batchSize: ctx.config.dbBatchSize,
    maxFileBytes: ctx.config.maxFileBytes,
    settleSeconds: ctx.config.settleSeconds,
    pathAllowed: (p) => resolveAllowed(p, { roots: ctx.config.allowedRoots, dataDir: ctx.config.dataDir, want: "file" }).ok,
  });
  return served(entry, source, null);
}

function buildDrive(entry: RegistrySource, ctx: BuildContext): ServedSource {
  const cfg = entry.config as DriveConfig;
  const env = ctx.env ?? process.env;
  if (!env.GOOGLE_API_KEY) {
    return served(entry, null, new DriveError("no-key", "Google Drive isn't set up on this server (GOOGLE_API_KEY is missing).").message);
  }
  const api = new DriveApi({ apiKey: env.GOOGLE_API_KEY, base: driveApiBase(env) });
  const source = new GoogleDriveSource({ id: entry.id, name: entry.name, folderId: cfg.folderId, api, maxFileBytes: ctx.config.maxFileBytes });
  return served(entry, source, null);
}
