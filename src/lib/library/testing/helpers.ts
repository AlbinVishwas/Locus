import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFixturePdf, type FixturePage } from "../../../../scripts/indexer/fixtures";
import { libraryPaths, loadLibraryConfig, type LibraryConfig } from "../config";
import type { GuardLike } from "../pipeline";

/**
 * Test-only helpers. A fake guard stands in for the external drive (tests
 * can't plug one in): it can be "unplugged" and "plugged back", and given
 * any amount of free space. The real guard and volume checks have their own
 * tests (storage/volume.test.ts), including a real refusal of this Mac's
 * internal disk.
 */

export interface FakeGuard extends GuardLike {
  connected: boolean;
  free: number;
  waits: number;
}

export function fakeGuard(dataDir: string, minFreeBytes = 1024): FakeGuard {
  const paths = libraryPaths(dataDir);
  for (const d of [paths.root, paths.tmp, paths.logs, paths.inventory]) fs.mkdirSync(d, { recursive: true });
  const g: FakeGuard = {
    paths,
    connected: true,
    free: 100 * 1024 ** 3,
    waits: 0,
    minFreeBytes,
    isConnected: () => g.connected,
    verifyConnected: async () => g.connected,
    async waitForReconnect(signal, intervalMs = 10) {
      while (!signal.aborted) {
        if (g.connected) return true;
        g.waits++;
        await new Promise((r) => setTimeout(r, Math.min(intervalMs, 20)));
      }
      return false;
    },
    freeBytes: () => g.free,
    hasEnoughSpace: () => g.free >= minFreeBytes,
  };
  return g;
}

export function testConfig(overrides: Partial<LibraryConfig> = {}): LibraryConfig {
  return {
    ...loadLibraryConfig({}),
    ocrLang: "eng",
    ocrDpi: 150,
    concurrency: 4,
    filesInFlight: 2,
    settleSeconds: 0,
    pageWindow: 5,
    ...overrides,
  };
}

export async function makePdf(file: string, pages: FixturePage[], workDir: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await writeFixturePdf(file, pages, { workDir });
}

/** Every file under `root`: size, mtime, inode, content hash. Equal before/after = nothing was written. */
export function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const st = fs.lstatSync(full);
      if (e.isDirectory()) {
        out[path.relative(root, full) + "/"] = `${st.mtimeMs}:${st.ino}:${st.mode}`;
        walk(full);
      } else {
        const sha = e.isFile() ? createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "link";
        out[path.relative(root, full)] = `${st.size}:${st.mtimeMs}:${st.ino}:${st.mode}:${sha}`;
      }
    }
  };
  walk(root);
  return out;
}
