import fs from "node:fs";
import path from "node:path";
import { runText } from "../../../../scripts/indexer/exec";
import { isUnderVolumes } from "./location";

/**
 * Which volume a folder is really on, and whether the library may write
 * there. Detected from the system, never guessed from the path:
 *
 *   df -P <dir>              the device and mount point actually holding it
 *                            (paths under /Users live on /System/Volumes/Data
 *                            through firmlinks; `mount` alone can't tell)
 *   mount                    that mount's filesystem type and flags ("local"
 *                            is absent on network mounts)
 *   diskutil info -plist     Internal, BusProtocol, the APFS container, the
 *                            volume UUID
 *
 * The library's data may live on this Mac's own disk (the default, capped by
 * LOCUS_LIBRARY_MAX_GB and kept clear of the free-space reserve: see
 * limits.ts) or on an external drive. Refused, each with its own message:
 *   - a network filesystem: SQLite's locking and WAL aren't safe there
 *   - FAT32 ("msdos"): no file over 4 GB, and the index will be far bigger
 *   - exFAT, unless LOCUS_DATA_DIR_ALLOW_EXFAT=true: no journal, so pulling
 *     the drive mid-write -- a case the library is built to survive -- can
 *     damage the filesystem itself, underneath SQLite, and macOS's exFAT
 *     driver gives weaker flush guarantees than APFS. APFS is recommended.
 *   - read-only volumes, and anything that can't be identified for sure
 * A disk image is allowed with a warning (it's a file-backed volume).
 *
 * A folder under /Volumes that doesn't exist is refused rather than created:
 * after a drive is unplugged macOS can leave an empty /Volumes/<name> folder
 * on the internal disk, and creating the data dir there would quietly put the
 * library on the wrong disk. Anywhere else, a missing folder is created.
 */

export type Runner = (command: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = (command, args) => runText(command, args, { timeoutMs: 15_000 });

export interface VolumeInfo {
  dir: string;
  device: string;
  mountPoint: string;
  fsType: string;
  local: boolean;
  internal: boolean | null;
  busProtocol: string | null;
  container: string | null;
  volumeUuid: string | null;
  volumeName: string | null;
  writable: boolean | null;
}

export type RefusalReason =
  | "unset"
  | "missing"
  | "not-a-directory"
  | "network"
  | "fat32"
  | "exfat"
  | "read-only"
  | "unidentified";

export type VolumeVerdict =
  | { ok: true; info: VolumeInfo; warnings: string[] }
  | { ok: false; reason: RefusalReason; message: string; info?: VolumeInfo };

const NETWORK_TYPES = new Set(["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp", "macfuse", "osxfuse", "fusefs"]);

const APFS_HINT =
  "Use this Mac's own disk (leave LOCUS_DATA_DIR unset), or an external drive formatted as APFS (Disk Utility → Erase → APFS) with LOCUS_DATA_DIR set to a folder on it, e.g. /Volumes/<drive>/locus-data.";

/**
 * Top-level scalar keys of an XML property list (what `diskutil info
 * -plist` prints). Nested arrays/dicts are skipped; nothing here needs them.
 */
export function parsePlistScalars(xml: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const body = xml.slice(xml.indexOf("<dict>") + "<dict>".length, xml.lastIndexOf("</dict>"));
  const token = /<key>([^<]*)<\/key>|<(string|integer|real)>([^<]*)<\/\2>|<(true|false)\/>|<(dict|array)>|<\/(dict|array)>|<(dict|array)\/>/g;
  let depth = 0;
  let pendingKey: string | null = null;
  for (const m of xml.length ? body.matchAll(token) : []) {
    if (m[5]) {
      depth++;
      pendingKey = null;
      continue;
    }
    if (m[6]) {
      depth--;
      continue;
    }
    if (m[7]) {
      pendingKey = null;
      continue;
    }
    if (depth !== 0) continue;
    if (m[1] !== undefined) {
      pendingKey = decodeXml(m[1]);
    } else if (pendingKey !== null) {
      if (m[2] === "string") out[pendingKey] = decodeXml(m[3]);
      else if (m[2]) out[pendingKey] = Number(m[3]);
      else if (m[4]) out[pendingKey] = m[4] === "true";
      pendingKey = null;
    }
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** `df -P <dir>`: the last line's device (first field) and mount point (everything from field 6 on, which may contain spaces). */
export function parseDf(out: string): { device: string; mountPoint: string } {
  const lines = out.trim().split("\n");
  const last = lines[lines.length - 1];
  const m = last.match(/^(.*?)\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.*)$/);
  if (!m) throw new Error(`unexpected df output: ${last}`);
  return { device: m[1], mountPoint: m[2] };
}

/** The `mount` line for one mount point: filesystem type and flags. */
export function parseMountLine(out: string, mountPoint: string): { fsType: string; flags: string[] } | null {
  for (const line of out.split("\n")) {
    const m = line.match(/^(.*) on (.*) \(([^)]*)\)$/);
    if (!m || m[2] !== mountPoint) continue;
    const [fsType, ...flags] = m[3].split(",").map((s) => s.trim());
    return { fsType, flags };
  }
  return null;
}

export async function probeVolume(dir: string, run: Runner = defaultRunner): Promise<VolumeInfo> {
  const real = fs.realpathSync(dir);
  const { device, mountPoint } = parseDf(await run("df", ["-P", real]));
  const mountLine = parseMountLine(await run("mount", []), mountPoint);
  const fsType = mountLine?.fsType ?? "unknown";
  const local = mountLine?.flags.includes("local") ?? false;

  let plist: Record<string, string | number | boolean> = {};
  // diskutil only knows disks; for a network mount it just fails.
  if (local && !NETWORK_TYPES.has(fsType)) {
    try {
      plist = parsePlistScalars(await run("diskutil", ["info", "-plist", mountPoint]));
    } catch {
      plist = {};
    }
  }
  const str = (k: string) => (typeof plist[k] === "string" ? (plist[k] as string) : null);
  const bool = (k: string) => (typeof plist[k] === "boolean" ? (plist[k] as boolean) : null);
  return {
    dir: real,
    device,
    mountPoint,
    fsType: str("FilesystemType") ?? fsType,
    local,
    internal: bool("Internal"),
    busProtocol: str("BusProtocol"),
    container: str("APFSContainerReference") ?? str("ParentWholeDisk"),
    volumeUuid: str("VolumeUUID"),
    volumeName: str("VolumeName"),
    writable: bool("Writable"),
  };
}

/** The nearest folder that exists at or above `p` (the volume a to-be-created folder would land on). */
function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return cur;
}

/**
 * The verdict for LOCUS_DATA_DIR. `allowExfat` is the one override there is
 * (LOCUS_DATA_DIR_ALLOW_EXFAT); nothing lets a network drive or FAT32
 * through. The Mac's own disk is fine: its limits are the cap and the
 * free-space reserve (limits.ts), not the volume check.
 */
export async function checkDataDir(
  dataDir: string | null,
  options: { allowExfat?: boolean; run?: Runner } = {}
): Promise<VolumeVerdict> {
  const run = options.run ?? defaultRunner;
  if (!dataDir) {
    return {
      ok: false,
      reason: "unset",
      message: `No data folder is configured for the library. ${APFS_HINT}`,
    };
  }
  let probeDir = dataDir;
  if (!fs.existsSync(dataDir)) {
    if (isUnderVolumes(dataDir)) {
      return {
        ok: false,
        reason: "missing",
        message:
          `LOCUS_DATA_DIR (${dataDir}) does not exist. Is the external drive plugged in and mounted? ` +
          `Locus never creates a folder under /Volumes itself -- create it once on the drive (mkdir "${dataDir}").`,
      };
    }
    // Anywhere else it will be created; judge the volume it would land on.
    probeDir = nearestExisting(dataDir);
  } else if (!fs.statSync(dataDir).isDirectory()) {
    return { ok: false, reason: "not-a-directory", message: `LOCUS_DATA_DIR (${dataDir}) is not a folder.` };
  }

  let info: VolumeInfo;
  try {
    info = await probeVolume(probeDir, run);
  } catch (err) {
    return {
      ok: false,
      reason: "unidentified",
      message: `Couldn't identify the volume holding the library data (${dataDir}): ${err instanceof Error ? err.message : err}. Refusing rather than guess.`,
    };
  }
  const where = `The library data folder (${dataDir}) is on ${info.volumeName ? `"${info.volumeName}" ` : ""}${info.mountPoint} (${info.fsType})`;

  if (!info.local || NETWORK_TYPES.has(info.fsType)) {
    return {
      ok: false,
      reason: "network",
      info,
      message: `${where}, a network filesystem. SQLite's locking isn't safe on network drives, so the library index can't live there. ${APFS_HINT}`,
    };
  }
  if (info.fsType === "msdos") {
    return {
      ok: false,
      reason: "fat32",
      info,
      message: `${where}: FAT32 can't hold a file over 4 GB, and the library index will be much larger. ${APFS_HINT}`,
    };
  }
  if (info.fsType === "exfat" && !options.allowExfat) {
    return {
      ok: false,
      reason: "exfat",
      info,
      message:
        `${where}: exFAT has no journal, so unplugging the drive mid-write can damage the filesystem itself, not just the index. ` +
        `${APFS_HINT} To use this exFAT drive anyway, set LOCUS_DATA_DIR_ALLOW_EXFAT=true.`,
    };
  }
  if (info.internal === null) {
    return {
      ok: false,
      reason: "unidentified",
      info,
      message: `${where}, but diskutil couldn't identify the disk. Refusing rather than guess.`,
    };
  }
  if (info.writable === false) {
    return { ok: false, reason: "read-only", info, message: `${where}, which is mounted read-only.` };
  }

  const warnings: string[] = [];
  if (info.fsType === "exfat") {
    warnings.push(
      `LOCUS_DATA_DIR is on exFAT (allowed by LOCUS_DATA_DIR_ALLOW_EXFAT). Unplugging mid-write can damage the drive's filesystem; APFS is recommended.`
    );
  }
  if (info.busProtocol === "Disk Image") {
    warnings.push(`The library data folder is on a mounted disk image, which is backed by a file on another disk.`);
  }
  return { ok: true, info, warnings };
}

export function describeVolume(info: VolumeInfo): string {
  return `${info.volumeName ?? path.basename(info.mountPoint)} (${info.mountPoint}, ${info.fsType}, ${info.busProtocol ?? "?"})`;
}
