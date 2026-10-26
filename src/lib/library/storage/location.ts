import fs from "node:fs";
import path from "node:path";
import { appDir } from "../../appDir";

/**
 * Where the library lives, as the app needs to know it: a small note the
 * indexer writes in the app's own folder (not on the library's drive) at
 * start-up, so the app can say "Library drive not connected" only when the
 * library really is on a drive that can be unplugged. Kept apart from
 * volume.ts/guard.ts so the app doesn't import the volume tooling.
 */

export interface LibraryLocation {
  dataDir: string;
  external: boolean;
  volumeName: string | null;
  volumeUuid: string | null;
  at: string;
}

export const LOCATION_FILE = "library-location.json";

export function locationFilePath(): string {
  return path.join(appDir(), LOCATION_FILE);
}

export function readLocation(file = locationFilePath()): LibraryLocation | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LibraryLocation;
  } catch {
    return null;
  }
}

/** True for paths on an external/network volume mount point, where a missing folder means "the drive isn't there". */
export function isUnderVolumes(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === "/Volumes" || resolved.startsWith("/Volumes/");
}
