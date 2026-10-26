import fs from "node:fs";
import type Database from "better-sqlite3";
import { loadLibraryConfig, libraryPaths, type LibraryConfig } from "../config";
import { libraryDataDir } from "../db";
import { openRegistry } from "./registry";

/**
 * The app's handle on the sources registry (sources.db in the library's data
 * folder). The app writes it from the admin APIs; the indexer worker reads
 * it every couple of seconds. Opened per request and closed after: these are
 * rare, small calls, and an unplugged drive then can't leave a handle behind.
 */

export function appLibraryConfig(): LibraryConfig {
  return loadLibraryConfig({ ...process.env, LOCUS_DATA_DIR: libraryDataDir() });
}

export function withRegistry<T>(fn: (registry: Database.Database, config: LibraryConfig) => T): T {
  const config = appLibraryConfig();
  const paths = libraryPaths(config.dataDir);
  if (!fs.existsSync(paths.dataDir)) throw new RegistryUnavailable("The library's data folder isn't available (is the drive connected?).");
  const registry = openRegistry(paths.sources);
  try {
    return fn(registry, config);
  } finally {
    registry.close();
  }
}

export class RegistryUnavailable extends Error {}
