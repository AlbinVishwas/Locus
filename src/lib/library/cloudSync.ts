import os from "node:os";
import path from "node:path";

/**
 * Is a folder inside a cloud-sync location (Google Drive, OneDrive, Dropbox,
 * iCloud, Box, pCloud...)? Reading files there can make the sync client
 * download them to this Mac, so a source folder like that gets a clear
 * warning. (Phase 1's online-only skip stays: a placeholder file is never
 * read, so it is never downloaded.)
 *
 * Judged on the real path (symlinks resolved by the caller) and, when it's
 * known, the filesystem type -- Google Drive for desktop and others mount
 * through FUSE.
 */

export interface CloudSyncMatch {
  provider: string;
}

export const CLOUD_SYNC_WARNING =
  "This folder is synced from the cloud. Reading its files can download them to this Mac, which uses disk space outside the library's limit. Online-only files are skipped, never downloaded.";

const FUSE_TYPES = new Set(["macfuse", "osxfuse", "fusefs", "fuse", "fskit"]);

// Matched against each path segment, lower-cased with spaces, dashes and underscores removed.
const SEGMENT_PROVIDERS: Array<[RegExp, string]> = [
  [/^googledrive/, "Google Drive"],
  [/^mydrive$/, "Google Drive"],
  [/^onedrive/, "OneDrive"],
  [/^dropbox(\(.*\))?$/, "Dropbox"],
  [/^iclouddrive/, "iCloud Drive"],
  [/^boxsync$/, "Box"],
  [/^box(box)?$/, "Box"],
  [/^pcloud(drive)?$/, "pCloud"],
  [/^megasync$/, "MEGA"],
  [/^sharepoint/, "SharePoint"],
];

export function detectCloudSync(realPath: string, options: { home?: string; fsType?: string | null } = {}): CloudSyncMatch | null {
  const home = options.home ?? os.homedir();
  const resolved = path.resolve(realPath);

  const cloudStorage = path.join(home, "Library", "CloudStorage") + path.sep;
  if (resolved.startsWith(cloudStorage)) {
    const first = resolved.slice(cloudStorage.length).split(path.sep)[0] ?? "";
    for (const [re, provider] of SEGMENT_PROVIDERS) if (re.test(normalize(first))) return { provider };
    return { provider: "a cloud-synced folder" };
  }
  if (resolved.startsWith(path.join(home, "Library", "Mobile Documents") + path.sep)) return { provider: "iCloud Drive" };

  for (const segment of resolved.split(path.sep)) {
    const n = normalize(segment);
    if (n === "") continue;
    for (const [re, provider] of SEGMENT_PROVIDERS) if (re.test(n)) return { provider };
  }
  if (options.fsType && FUSE_TYPES.has(options.fsType)) return { provider: "a FUSE-mounted cloud drive" };
  return null;
}

function normalize(segment: string): string {
  return segment.toLowerCase().replace(/[\s\-_]+/g, "");
}
