import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDataDir, parseProcMounts, probeGeneric } from "./volume";

/** The storage-folder check on Windows and Linux, where diskutil doesn't exist. */

const MOUNTS = [
  "/dev/sda1 / ext4 rw,relatime 0 0",
  "/dev/sdb1 /mnt/data ext4 rw 0 0",
  "//nas01/share /mnt/nas cifs rw,vers=3.0 0 0",
  "nas02:/export /mnt/nfs nfs4 rw 0 0",
  "/dev/sdc1 /mnt/my\\040drive ext4 rw 0 0",
  "sshfs#me@host: /mnt/ssh fuse.sshfs rw 0 0",
].join("\n");

describe("Linux: /proc/mounts", () => {
  it("picks the longest matching mount point", () => {
    expect(parseProcMounts(MOUNTS, "/mnt/data/locus")).toMatchObject({ mountPoint: "/mnt/data", fsType: "ext4" });
    expect(parseProcMounts(MOUNTS, "/home/me/locus")).toMatchObject({ mountPoint: "/", fsType: "ext4" });
    expect(parseProcMounts(MOUNTS, "/mnt/my drive/x")).toMatchObject({ mountPoint: "/mnt/my drive" });
    expect(parseProcMounts(MOUNTS, "/mnt/datax")).toMatchObject({ mountPoint: "/" }); // not a prefix of /mnt/data
  });

  it("flags network filesystems (SQLite locking isn't safe there) and accepts local ones", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locus-vol-"));
    try {
      const local = probeGeneric(tmp, "linux", () => MOUNTS, () => "/mnt/data/locus");
      expect(local).toMatchObject({ fsType: "ext4", local: true, internal: true, volumeUuid: null });
      for (const [p, type] of [["/mnt/nas/x", "cifs"], ["/mnt/nfs/x", "nfs4"], ["/mnt/ssh/x", "fuse.sshfs"]] as const) {
        expect(probeGeneric(tmp, "linux", () => MOUNTS, () => p), p).toMatchObject({ fsType: type, local: false });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an unreadable /proc (a container) is treated as local", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locus-vol-"));
    try {
      expect(probeGeneric(tmp, "linux", () => { throw new Error("no /proc"); }).local).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Windows paths", () => {
  const tmp = os.tmpdir();
  it("a UNC path (\\\\server\\share) is a network location; a drive letter and a long-path drive are local", () => {
    expect(probeGeneric(tmp, "win32", undefined, () => "\\\\nas01\\share\\locus")).toMatchObject({ local: false, fsType: "smb" });
    expect(probeGeneric(tmp, "win32", undefined, () => "C:\\Users\\me\\locus")).toMatchObject({ local: true });
    expect(probeGeneric(tmp, "win32", undefined, () => "\\\\?\\C:\\Users\\me\\locus")).toMatchObject({ local: true });
  });
});

describe("checkDataDir on this system", () => {
  it("accepts a normal writable folder (any OS) and refuses a missing-parent 'unset' folder with a message", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "locus-data-"));
    try {
      const ok = await checkDataDir(path.join(tmp, "locus-data"));
      expect(ok.ok, JSON.stringify(ok)).toBe(true);
      const unset = await checkDataDir(null);
      expect(unset).toMatchObject({ ok: false, reason: "unset" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
