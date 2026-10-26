import fs from "node:fs";
import path from "node:path";
import { libraryPaths, type LibraryPaths } from "../config";
import { defaultMarginBytes, evaluateLimits, type LimitState } from "./limits";
import { UsageMeter } from "./usage";
import { isUnderVolumes, locationFilePath, type LibraryLocation } from "./location";
import { checkDataDir, describeVolume, type RefusalReason, type Runner, type VolumeInfo } from "./volume";

/**
 * Keeps every library write inside the folder LOCUS_DATA_DIR points at, and
 * inside its limits, for as long as a run lasts:
 *
 *   init()          the volume check (volume.ts), then -- for the default
 *                   folder, or any folder not under /Volumes -- creating the
 *                   folder, then the marker file `.locus-data-dir` recording
 *                   that volume's UUID. A marker from a different volume is
 *                   refused: the folder was copied, or a different drive is
 *                   mounted at the same path. Also writes a small note in the
 *                   app's own folder saying where the library lives and
 *                   whether that's an external drive, so the app can say
 *                   "drive not connected" only when it really means it.
 *   isConnected()   cheap, called before every write batch: the marker is
 *                   still there and still on the same device. An unplugged
 *                   drive fails this, and so does an empty /Volumes/<name>
 *                   folder macOS left behind (no marker in it).
 *   waitForReconnect()  polls until the full check passes again with the
 *                   same volume UUID.
 *   checkLimits()   the storage cap and free-space reserve (limits.ts), from
 *                   real disk usage (usage.ts) and statfs.
 */

export class StorageRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: RefusalReason | "marker-mismatch"
  ) {
    super(message);
  }
}

interface Marker {
  volumeUuid: string | null;
  createdAt: string;
  version: 1;
}

export interface GuardOptions {
  allowExfat: boolean;
  /** Free space to always leave on the disk. */
  minFreeBytes: number;
  /** Cap on everything the library writes. Omitted: no cap (the inventory, which writes little). */
  capBytes?: number;
  capMarginBytes?: number;
  run?: Runner;
  /** Where to record the library's location; null: don't (tests). Default: the app folder. */
  locationFile?: string | null;
  /** Injectable for tests: free bytes on the volume holding `dir`. */
  freeBytesOf?: (dir: string) => number;
  /** Injectable for tests: what the library is using right now. */
  usedBytesOf?: () => number;
}

export function statfsFreeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export class DataDirGuard {
  readonly paths: LibraryPaths;
  private markerDev: number | null = null;
  private volumeUuid: string | null = null;
  private meter: UsageMeter | null = null;
  info: VolumeInfo | null = null;
  warnings: string[] = [];

  constructor(
    readonly dataDir: string | null,
    private readonly options: GuardOptions
  ) {
    this.paths = libraryPaths(dataDir ?? "/nonexistent-locus-data-dir");
  }

  async init(): Promise<void> {
    const verdict = await checkDataDir(this.dataDir, { allowExfat: this.options.allowExfat, run: this.options.run });
    if (!verdict.ok) throw new StorageRefusedError(verdict.message, verdict.reason);
    this.info = verdict.info;
    this.warnings = verdict.warnings;
    this.volumeUuid = verdict.info.volumeUuid;
    // Not under /Volumes (checkDataDir already refused a missing folder there).
    if (!fs.existsSync(this.paths.dataDir)) fs.mkdirSync(this.paths.dataDir, { recursive: true });

    const existing = this.readMarker();
    if (existing && existing.volumeUuid !== this.volumeUuid) {
      throw new StorageRefusedError(
        `${this.paths.marker} was created on a different volume (${existing.volumeUuid}) than the one now mounted there (${this.volumeUuid}, ${describeVolume(verdict.info)}). ` +
          `If you moved the library data to a new drive on purpose, delete that marker file and run again.`,
        "marker-mismatch"
      );
    }
    if (!existing) {
      const marker: Marker = { volumeUuid: this.volumeUuid, createdAt: new Date().toISOString(), version: 1 };
      fs.writeFileSync(this.paths.marker, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" });
    }
    this.markerDev = fs.statSync(this.paths.marker).dev;
    // Only ever inside the verified data dir -- never the data dir itself.
    for (const dir of [this.paths.root, this.paths.tmp, this.paths.logs, this.paths.inventory]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.meter = new UsageMeter(this.paths);
    this.writeLocation();
  }

  private writeLocation(): void {
    const file = this.options.locationFile === undefined ? locationFilePath() : this.options.locationFile;
    if (file === null || !this.info) return;
    const location: LibraryLocation = {
      dataDir: this.paths.dataDir,
      external: isUnderVolumes(this.paths.dataDir) || this.info.internal === false,
      volumeName: this.info.volumeName,
      volumeUuid: this.volumeUuid,
      at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(location, null, 2) + "\n");
    } catch {
      // The note only sharpens a message; never fail a run over it.
    }
  }

  private readMarker(): Marker | null {
    try {
      return JSON.parse(fs.readFileSync(this.paths.marker, "utf8")) as Marker;
    } catch {
      return null;
    }
  }

  /** Cheap: marker present, on the same device as at init. */
  isConnected(): boolean {
    if (this.markerDev === null) return false;
    try {
      return fs.statSync(this.paths.marker).dev === this.markerDev;
    } catch {
      return false;
    }
  }

  /** The full check again: same volume (by UUID), marker intact. */
  async verifyConnected(): Promise<boolean> {
    const verdict = await checkDataDir(this.dataDir, { allowExfat: this.options.allowExfat, run: this.options.run });
    if (!verdict.ok || verdict.info.volumeUuid !== this.volumeUuid) return false;
    const marker = this.readMarker();
    if (!marker || marker.volumeUuid !== this.volumeUuid) return false;
    this.markerDev = fs.statSync(this.paths.marker).dev;
    this.info = verdict.info;
    return true;
  }

  async waitForReconnect(signal: AbortSignal, intervalMs = 10_000, onWait?: () => void): Promise<boolean> {
    while (!signal.aborted) {
      if (await this.verifyConnected()) return true;
      onWait?.();
      await sleep(intervalMs, signal);
    }
    return false;
  }

  freeBytes(): number {
    return (this.options.freeBytesOf ?? statfsFreeBytes)(this.paths.dataDir);
  }

  usedBytes(): number {
    if (this.options.usedBytesOf) return this.options.usedBytesOf();
    return (this.meter ??= new UsageMeter(this.paths)).usedBytes();
  }

  /** The storage cap and the free-space reserve. Cheap enough to call before every write. */
  checkLimits(): LimitState {
    const capBytes = this.options.capBytes ?? Number.MAX_SAFE_INTEGER;
    return evaluateLimits({
      usedBytes: this.usedBytes(),
      capBytes,
      freeBytes: this.freeBytes(),
      minFreeBytes: this.options.minFreeBytes,
      marginBytes: this.options.capMarginBytes ?? (this.options.capBytes ? defaultMarginBytes(capBytes) : 0),
    });
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
