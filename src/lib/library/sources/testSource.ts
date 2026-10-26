import { detectCloudSync, CLOUD_SYNC_WARNING } from "../cloudSync";
import type { LibraryConfig } from "../config";
import type { SourceEntry } from "./types";
import { parseSourceInput } from "./admin";
import { DriveApi, driveApiBase } from "./gdriveApi";
import { openRegistry, addRegistrySource } from "./registry";
import { buildServedSource } from "./build";
import type { DriveConfig, FolderConfig } from "./forms";

/**
 * The Test button: does this source work, and what is in it? It builds the
 * source exactly as the indexer would (same checks, same code), reads a few
 * entries, and stops. Nothing is saved and nothing is indexed.
 */

export interface TestResult {
  ok: boolean;
  message: string;
  /** A few names from the source (never paths outside it). */
  samples: string[];
  /** Things worth knowing that don't stop it working. */
  warnings: string[];
  /** Folder: how many PDFs were found before the test stopped counting. */
  found?: number;
  atLeast?: boolean;
  /** Drive: the folder's name, to suggest as the source's name. */
  folderName?: string;
}

const SAMPLE = 5;
const FOLDER_COUNT_CAP = 5000;
const FOLDER_TIME_MS = 8000;

export interface TestOptions {
  env?: Record<string, string | undefined>;
  /** Test hook. */
  folderTimeMs?: number;
  folderCap?: number;
}

export async function testSource(body: unknown, config: LibraryConfig, options: TestOptions = {}): Promise<TestResult> {
  const parsed = parseSourceInput(body, config);
  if (!parsed.ok) return { ok: false, message: parsed.error, samples: [], warnings: [] };

  // The same builder the indexer uses, against a throwaway registry that holds the password in memory only.
  const registry = openRegistry(":memory:");
  const env = options.env ?? process.env;
  try {
    let entry;
    try {
      entry = addRegistrySource(registry, { kind: parsed.kind, name: parsed.name, config: parsed.config, ...(parsed.secret !== undefined ? { secret: parsed.secret } : {}) });
    } catch (err) {
      return { ok: false, message: err instanceof Error && /LOCUS_SECRETS_KEY|secret/i.test(err.message) ? `Passwords can't be saved yet: ${err.message}` : "Couldn't set up the test.", samples: [], warnings: [] };
    }
    const served = buildServedSource(entry, { config, registry, env });
    if (!served.source) return { ok: false, message: served.error ?? "This source can't be used.", samples: [], warnings: [] };

    const warnings: string[] = [];
    const result: TestResult = { ok: true, message: "", samples: [], warnings };
    if (parsed.kind === "folder") {
      const path = (parsed.config as FolderConfig).path;
      if (detectCloudSync(path)) warnings.push(CLOUD_SYNC_WARNING);
    }

    const controller = new AbortController();
    const deadline = options.folderTimeMs ?? FOLDER_TIME_MS;
    const timer = parsed.kind === "folder" ? setTimeout(() => controller.abort(), deadline) : null;
    const cap = options.folderCap ?? FOLDER_COUNT_CAP;
    let count = 0;
    let stoppedEarly = false;
    try {
      for await (const e of served.source.scan(controller.signal, () => {}, () => {})) {
        count++;
        if (result.samples.length < SAMPLE) result.samples.push((e as SourceEntry).displayName);
        // A folder is counted a while (it shows "at least N"); anything else needs only a few rows.
        if (parsed.kind !== "folder" && count >= SAMPLE) {
          stoppedEarly = true;
          break;
        }
        if (parsed.kind === "folder" && count >= cap) {
          stoppedEarly = true;
          break;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) return { ok: false, message: scrub(err instanceof Error ? err.message : String(err), parsed.secret), samples: [], warnings };
      stoppedEarly = true;
    } finally {
      if (timer) clearTimeout(timer);
      await served.source.close().catch(() => {});
    }
    if (controller.signal.aborted) stoppedEarly = true;

    if (parsed.kind === "folder") {
      result.found = count;
      result.atLeast = stoppedEarly;
      result.message =
        count === 0
          ? "Locus can read this folder, but found no PDFs in it."
          : `Locus can read this folder. Found ${stoppedEarly ? "at least " : ""}${count.toLocaleString()} PDF${count === 1 ? "" : "s"}.`;
      if (count === 0) result.ok = true;
    } else if (parsed.kind === "database") {
      result.message = count === 0 ? "Connected, but the table has no rows." : `Connected. Read ${count} sample row${count === 1 ? "" : "s"}.`;
    } else {
      const folderId = (parsed.config as DriveConfig).folderId;
      try {
        const api = new DriveApi({ apiKey: env.GOOGLE_API_KEY, base: driveApiBase(env), maxTries: 2 });
        result.folderName = (await api.getFolder(folderId)).name;
      } catch {
        // the listing above already worked; the name is only a nicety
      }
      result.message = count === 0 ? "Found the folder, but no PDFs in it yet." : `Found the folder${result.folderName ? ` “${result.folderName}”` : ""}. First PDFs listed.`;
    }
    return result;
  } finally {
    registry.close();
  }
}

/** A message from a driver can echo what was typed; the password never leaves the server. */
function scrub(message: string, secret?: string): string {
  return secret ? message.split(secret).join("•••") : message;
}
