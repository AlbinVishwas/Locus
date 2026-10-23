import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataDirGuard, StorageRefusedError } from "./guard";
import { checkDataDir, parseDf, parseMountLine, parsePlistScalars, type Runner } from "./volume";

const FIX = path.join(import.meta.dirname, "__fixtures__");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8");
const THIS_MAC_MOUNT = fixture("mount-this-mac.txt");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-volume-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  df: string;
  mountExtra?: string;
  diskutil?: string;
}

/**
 * Plays back `df`, `mount` and `diskutil` output. `diskutil info -plist /`
 * is always this Mac's real (trimmed) root volume, so the boot-container
 * comparison is against real data.
 */
function runner(s: Scenario, calls: string[] = []): Runner {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "df") return `Filesystem 512-blocks Used Available Capacity  Mounted on\n${s.df}\n`;
    if (command === "mount") return THIS_MAC_MOUNT + (s.mountExtra ?? "");
    if (command === "diskutil" && args[2] === "/") return fixture("diskutil-root.plist");
    if (command === "diskutil") {
      if (!s.diskutil) throw new Error("Could not find disk");
      return fixture(s.diskutil);
    }
    throw new Error(`unexpected command ${command}`);
  };
}

const EXTERNAL_APFS: Scenario = {
  df: "/dev/disk5s1  1953514584 123456 1953391128     1%    /Volumes/LocusSSD",
  mountExtra: "/dev/disk5s1 on /Volumes/LocusSSD (apfs, local, nodev, nosuid, journaled, noowners)\n",
  diskutil: "diskutil-external-apfs.plist",
};

describe("parsers", () => {
  it("reads top-level scalars from a real diskutil plist, skipping nested values", () => {
    const p = parsePlistScalars(fixture("diskutil-data.plist"));
    expect(p).toMatchObject({
      Internal: true,
      FilesystemType: "apfs",
      MountPoint: "/System/Volumes/Data",
      APFSContainerReference: "disk3",
      BusProtocol: "Apple Fabric",
    });
    const nested = parsePlistScalars(
      `<plist><dict><key>A</key><array><string>x</string></array><key>B</key><dict><key>C</key><true/></dict><key>D</key><integer>7</integer></dict></plist>`
    );
    expect(nested).toEqual({ D: 7 });
  });

  it("df: device and a mount point with spaces", () => {
    expect(parseDf("Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk5s1 100 10 90 10% /Volumes/My Drive\n")).toEqual({
      device: "/dev/disk5s1",
      mountPoint: "/Volumes/My Drive",
    });
  });

  it("mount: type and flags for one mount point", () => {
    expect(parseMountLine(THIS_MAC_MOUNT, "/System/Volumes/Data")).toEqual({
      fsType: "apfs",
      flags: ["local", "journaled", "nobrowse", "protect", "root data"],
    });
    expect(parseMountLine(THIS_MAC_MOUNT, "/Volumes/Nope")).toBeNull();
  });
});

describe("checkDataDir: refusals, each with its own message", () => {
  it("unset", async () => {
    const v = await checkDataDir(null);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toBe("unset");
    expect(v.message).toContain("LOCUS_DATA_DIR is not set");
    expect(v.message).toContain("APFS");
  });

  it("missing: never created, with a drive-not-mounted hint", async () => {
    const v = await checkDataDir(path.join(dir, "nope"));
    expect(v).toMatchObject({ ok: false, reason: "missing" });
    if (!v.ok) expect(v.message).toContain("Locus never creates this folder");
    expect(fs.existsSync(path.join(dir, "nope"))).toBe(false);
  });

  it("this Mac's internal data volume (real fixtures)", async () => {
    const v = await checkDataDir(dir, {
      run: runner({ df: "/dev/disk3s5  965492904 705421968 210048424    78%    /System/Volumes/Data", diskutil: "diskutil-data.plist" }),
    });
    expect(v).toMatchObject({ ok: false, reason: "internal" });
    if (!v.ok) expect(v.message).toContain("internal disk");
  });

  it("a ghost /Volumes/<name> folder left on the internal disk after an unplug resolves to the internal volume", async () => {
    // df reports the volume that actually holds the folder: the Data volume.
    const v = await checkDataDir(dir, {
      run: runner({ df: "/dev/disk3s5  965492904 705421968 210048424    78%    /System/Volumes/Data", diskutil: "diskutil-data.plist" }),
    });
    expect(v).toMatchObject({ ok: false, reason: "internal" });
  });

  it("SMB network share", async () => {
    const v = await checkDataDir(dir, {
      run: runner({
        df: "//albin@nas.local/share  1000 10 990 1% /Volumes/share",
        mountExtra: "//albin@nas.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by albin)\n",
      }),
    });
    expect(v).toMatchObject({ ok: false, reason: "network" });
    if (!v.ok) expect(v.message).toContain("network filesystem");
  });

  it("NFS share", async () => {
    const v = await checkDataDir(dir, {
      run: runner({
        df: "nas:/export  1000 10 990 1% /Volumes/nfs",
        mountExtra: "nas:/export on /Volumes/nfs (nfs, nodev, nosuid, mounted by albin)\n",
      }),
    });
    expect(v).toMatchObject({ ok: false, reason: "network" });
  });

  it("FAT32: refused outright, no override", async () => {
    const s = {
      df: "/dev/disk7s1 1000 10 990 1% /Volumes/FAT32",
      mountExtra: "/dev/disk7s1 on /Volumes/FAT32 (msdos, local, nodev, nosuid, noowners)\n",
      diskutil: "diskutil-external-msdos.plist",
    };
    const v = await checkDataDir(dir, { run: runner(s), allowExfat: true });
    expect(v).toMatchObject({ ok: false, reason: "fat32" });
    if (!v.ok) expect(v.message).toContain("4 GB");
  });

  it("exFAT: refused by default, recommending APFS and naming the override", async () => {
    const s = {
      df: "/dev/disk6s1 1000 10 990 1% /Volumes/EXFATDRIVE",
      mountExtra: "/dev/disk6s1 on /Volumes/EXFATDRIVE (exfat, local, nodev, nosuid, noowners)\n",
      diskutil: "diskutil-external-exfat.plist",
    };
    const refused = await checkDataDir(dir, { run: runner(s) });
    expect(refused).toMatchObject({ ok: false, reason: "exfat" });
    if (!refused.ok) {
      expect(refused.message).toContain("no journal");
      expect(refused.message).toContain("APFS");
      expect(refused.message).toContain("LOCUS_DATA_DIR_ALLOW_EXFAT=true");
    }
    const allowed = await checkDataDir(dir, { run: runner(s), allowExfat: true });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.warnings.join(" ")).toContain("APFS is recommended");
  });

  it("a mounted disk image", async () => {
    const v = await checkDataDir(dir, {
      run: runner({
        df: "/dev/disk9s1 1000 10 990 1% /Volumes/ImageVol",
        mountExtra: "/dev/disk9s1 on /Volumes/ImageVol (apfs, local, nodev, nosuid, journaled, noowners)\n",
        diskutil: "diskutil-disk-image.plist",
      }),
    });
    expect(v).toMatchObject({ ok: false, reason: "disk-image" });
  });

  it("an external volume that turns out to share the boot container", async () => {
    const v = await checkDataDir(dir, {
      run: async (command, args) => {
        if (command === "diskutil" && args[2] !== "/") {
          return fixture("diskutil-external-apfs.plist").replace("<string>disk5</string>", "<string>disk3</string>");
        }
        return runner(EXTERNAL_APFS)(command, args);
      },
    });
    expect(v).toMatchObject({ ok: false, reason: "boot-container" });
  });

  it("read-only external volume", async () => {
    const v = await checkDataDir(dir, {
      run: runner({
        df: "/dev/disk8s1 1000 10 990 1% /Volumes/ReadOnly",
        mountExtra: "/dev/disk8s1 on /Volumes/ReadOnly (apfs, local, read-only, journaled)\n",
        diskutil: "diskutil-external-readonly.plist",
      }),
    });
    expect(v).toMatchObject({ ok: false, reason: "read-only" });
  });

  it("a local disk diskutil can't identify is refused, not assumed external", async () => {
    const v = await checkDataDir(dir, {
      run: runner({
        df: "/dev/disk5s1 1000 10 990 1% /Volumes/LocusSSD",
        mountExtra: "/dev/disk5s1 on /Volumes/LocusSSD (apfs, local, journaled)\n",
      }),
    });
    expect(v).toMatchObject({ ok: false, reason: "unidentified" });
  });

  it("accepts an external APFS volume", async () => {
    const v = await checkDataDir(dir, { run: runner(EXTERNAL_APFS) });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.info).toMatchObject({ fsType: "apfs", internal: false, mountPoint: "/Volumes/LocusSSD", volumeName: "LocusSSD" });
      expect(v.warnings).toEqual([]);
    }
  });
});

describe.skipIf(process.platform !== "darwin")("checkDataDir on this Mac, for real", () => {
  it("refuses a folder on the internal disk using the real df/mount/diskutil", async () => {
    const v = await checkDataDir(dir);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(["internal", "boot-container"]).toContain(v.reason);
      expect(v.info?.internal).toBe(true);
    }
    const home = await checkDataDir(os.homedir());
    expect(home.ok).toBe(false);
  });
});

describe("DataDirGuard", () => {
  const options = (run: Runner, free = 100 * 1024 ** 3) => ({
    allowExfat: false,
    minFreeBytes: 20 * 1024 ** 3,
    run,
    freeBytesOf: () => free,
  });

  it("refuses on init exactly as checkDataDir does", async () => {
    const guard = new DataDirGuard(dir, options(runner({ df: "/dev/disk3s5 1 1 1 1% /System/Volumes/Data", diskutil: "diskutil-data.plist" })));
    await expect(guard.init()).rejects.toBeInstanceOf(StorageRefusedError);
    // Nothing written on a refusal.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("writes the marker and library folders inside the data dir, never above it", async () => {
    const guard = new DataDirGuard(dir, options(runner(EXTERNAL_APFS)));
    await guard.init();
    expect(fs.readdirSync(dir).sort()).toEqual([".locus-data-dir", "library"]);
    expect(fs.readdirSync(path.join(dir, "library")).sort()).toEqual(["inventory", "logs", "tmp"]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".locus-data-dir"), "utf8"))).toMatchObject({
      volumeUuid: "7D1E3C55-0000-4000-8000-000000000001",
      version: 1,
    });
    expect(guard.isConnected()).toBe(true);
  });

  it("isConnected() goes false when the marker vanishes (drive gone, or an empty ghost folder)", async () => {
    const guard = new DataDirGuard(dir, options(runner(EXTERNAL_APFS)));
    await guard.init();
    fs.rmSync(path.join(dir, ".locus-data-dir"));
    expect(guard.isConnected()).toBe(false);
    expect(await guard.verifyConnected()).toBe(false);
  });

  it("refuses a marker from a different volume", async () => {
    fs.writeFileSync(path.join(dir, ".locus-data-dir"), JSON.stringify({ volumeUuid: "OTHER", createdAt: "x", version: 1 }));
    const guard = new DataDirGuard(dir, options(runner(EXTERNAL_APFS)));
    await expect(guard.init()).rejects.toMatchObject({ reason: "marker-mismatch" });
  });

  it("waitForReconnect returns once the same volume is back", async () => {
    let attached = false;
    const run: Runner = async (c, a) => {
      if (!attached && c === "df") throw new Error("df: no such file");
      return runner(EXTERNAL_APFS)(c, a);
    };
    const guard = new DataDirGuard(dir, options(runner(EXTERNAL_APFS)));
    await guard.init();
    const g2 = Object.assign(Object.create(Object.getPrototypeOf(guard)), guard, { options: options(run) });
    setTimeout(() => (attached = true), 30);
    expect(await g2.waitForReconnect(new AbortController().signal, 10)).toBe(true);
  });

  it("reports free space against the threshold", async () => {
    const low = new DataDirGuard(dir, options(runner(EXTERNAL_APFS), 5 * 1024 ** 3));
    expect(low.hasEnoughSpace()).toBe(false);
    const fine = new DataDirGuard(dir, options(runner(EXTERNAL_APFS)));
    expect(fine.hasEnoughSpace()).toBe(true);
  });
});
