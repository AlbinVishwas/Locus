import { describe, expect, it } from "vitest";
import { CLOUD_SYNC_WARNING, detectCloudSync } from "./cloudSync";

const home = "/Users/albin";
const detect = (p: string, fsType?: string) => detectCloudSync(p, { home, fsType });

describe("detectCloudSync", () => {
  it("macOS File Provider locations", () => {
    expect(detect("/Users/albin/Library/CloudStorage/GoogleDrive-albin@example.com/My Drive/Tenders")).toEqual({ provider: "Google Drive" });
    expect(detect("/Users/albin/Library/CloudStorage/OneDrive-Personal/Docs")).toEqual({ provider: "OneDrive" });
    expect(detect("/Users/albin/Library/CloudStorage/Dropbox/Docs")).toEqual({ provider: "Dropbox" });
    expect(detect("/Users/albin/Library/CloudStorage/Box-Box/x")).toEqual({ provider: "Box" });
    expect(detect("/Users/albin/Library/CloudStorage/SomethingNew-Sync/x")).toEqual({ provider: "a cloud-synced folder" });
  });

  it("iCloud Drive", () => {
    expect(detect("/Users/albin/Library/Mobile Documents/com~apple~CloudDocs/Tenders")).toEqual({ provider: "iCloud Drive" });
    expect(detect("/Users/albin/iCloud Drive/Tenders")).toEqual({ provider: "iCloud Drive" });
  });

  it("classic sync folders, by any path segment", () => {
    expect(detect("/Users/albin/Dropbox/Tenders")).toEqual({ provider: "Dropbox" });
    expect(detect("/Users/albin/Dropbox (Personal)/Tenders")).toEqual({ provider: "Dropbox" });
    expect(detect("/Users/albin/OneDrive - Company/Tenders")).toEqual({ provider: "OneDrive" });
    expect(detect("/Users/albin/Google Drive/My Drive/x")).toEqual({ provider: "Google Drive" });
    expect(detect("/Volumes/GoogleDrive/My Drive/x")).toEqual({ provider: "Google Drive" });
    expect(detect("/Users/albin/pCloud Drive/x")).toEqual({ provider: "pCloud" });
  });

  it("a FUSE mount is flagged even with an ordinary-looking path", () => {
    expect(detect("/Volumes/Archive/Tenders", "macfuse")).toEqual({ provider: "a FUSE-mounted cloud drive" });
  });

  it("ordinary folders are not flagged, including look-alikes", () => {
    expect(detect("/Volumes/Archive/Tenders")).toBeNull();
    expect(detect("/Users/albin/Documents/Tenders")).toBeNull();
    expect(detect("/Users/albin/Developer/Projects/Locus/data/tenders", "apfs")).toBeNull();
    expect(detect("/Users/albin/dropbox-notes-archive/x")).toBeNull();
    expect(detect("/Users/albin/MyDriveBackups/x")).toBeNull();
  });

  it("has a warning that says what happens", () => {
    expect(CLOUD_SYNC_WARNING).toContain("synced from the cloud");
    expect(CLOUD_SYNC_WARNING).toContain("download");
    expect(CLOUD_SYNC_WARNING).toContain("Online-only files are skipped");
  });
});
