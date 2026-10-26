import { describe, expect, it } from "vitest";
import { formatBytes, storageLine, timeAgo } from "./format";

const GB = 1024 ** 3;
const NOW = Date.parse("2026-06-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatBytes", () => {
  it("picks a readable unit", () => {
    expect(formatBytes(38.2 * GB)).toBe("38.2 GB");
    expect(formatBytes(100 * GB)).toBe("100 GB");
    expect(formatBytes(412 * 1024 ** 2)).toBe("412 MB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(0)).toBe("0 KB");
  });
});

describe("timeAgo", () => {
  it("is plain", () => {
    expect(timeAgo(null)).toBe("Never");
    expect(timeAgo("garbage")).toBe("Never");
    expect(timeAgo(ago(10_000), NOW)).toBe("just now");
    expect(timeAgo(ago(12 * 60_000), NOW)).toBe("12 min ago");
    expect(timeAgo(ago(2 * 3_600_000), NOW)).toBe("2 h ago");
    expect(timeAgo(ago(24 * 3_600_000), NOW)).toBe("1 day ago");
    expect(timeAgo(ago(3 * 86_400_000), NOW)).toBe("3 days ago");
  });
});

describe("storageLine", () => {
  const limits = { capBytes: 100 * GB, minFreeBytes: 20 * GB };
  it("states usage against the cap and the reserve", () => {
    expect(storageLine({ usedBytes: 38.2 * GB, capBytes: 100 * GB, freeBytes: 96 * GB, minFreeBytes: 20 * GB }, limits)).toBe(
      "Library uses 38.2 GB of 100 GB · 96 GB free (20 GB kept in reserve)"
    );
  });
  it("falls back to the limits before the indexer has measured", () => {
    expect(storageLine({ usedBytes: null, capBytes: null, freeBytes: null, minFreeBytes: null }, limits)).toBe("Library limit 100 GB · 20 GB always kept free");
  });
});
