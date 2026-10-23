import fs from "node:fs";
import { libraryPaths, type LibraryPaths } from "../config";
import { checkDataDir, describeVolume, type RefusalReason, type Runner, type VolumeInfo } from "./volume";

/**
 * Keeps every library write on the external drive LOCUS_DATA_DIR points at,
 * for as long as a run lasts:
 *
 *   init()          the full volume check (volume.ts), then the marker file
 *                   `.locus-data-dir` recording that volume's UUID. A marker
 *                   from a different volume is refused: it means the folder
 *                   was copied, or a different drive is mounted at the same
 *                   path.
 *   isConnected()   cheap, called before every write batch: the marker is
 *                   still there and still on the same device. An unplugged
 *                   drive fails this, and so does an empty /Volumes/<name>
 *                   folder macOS left behind (no marker in it).
 *   waitForReconnect()  polls until the full check passes again with the
 *                   same volume UUID.
 *   freeBytes()     statfs on the drive, for the low-space pause.
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
  minFreeBytes: number;
  run?: Runner;
  /** Injectable for tests: free bytes on the volume holding `dir`. */
  freeBytesOf?: (dir: string) => number;
}

export function statfsFreeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export class DataDirGuard {
  readonly paths: LibraryPaths;
  private markerDev: number | null = null;
  private volumeUuid: string | null = null;
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

  hasEnoughSpace(): boolean {
    return this.freeBytes() >= this.options.minFreeBytes;
  }

  get minFreeBytes(): number {
    return this.options.minFreeBytes;
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
