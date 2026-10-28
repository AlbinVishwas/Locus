import { describe, expect, it } from "vitest";
import { DEFAULT_INDEX_RATIO, observedRatio, planSpace, SAFETY_FACTOR, spaceMessage } from "./preflight";

const GB = 1024 ** 3;

describe("index size estimate", () => {
  it("estimate = PDF bytes x ratio x safety factor, compared with free space minus the reserve", () => {
    const plan = planSpace({ files: 100, pdfBytes: 10 * GB, freeBytes: 100 * GB, reserveBytes: 5 * GB });
    expect(plan.estimateBytes).toBe(Math.ceil(10 * GB * DEFAULT_INDEX_RATIO * SAFETY_FACTOR));
    expect(plan.usableBytes).toBe(95 * GB);
    expect(plan.fits).toBe(true);
    expect(plan.shortByBytes).toBe(0);
  });

  it("refuses when it won't fit, and says by how much", () => {
    const plan = planSpace({ files: 5000, pdfBytes: 50 * GB, freeBytes: 60 * GB, reserveBytes: 5 * GB });
    expect(plan.fits).toBe(false);
    expect(plan.shortByBytes).toBe(plan.estimateBytes - 55 * GB);
    const msg = spaceMessage(plan, "/data/locus");
    expect(msg).toMatch(/^LOCUS-DISK-001: Not enough disk space to build the index\./);
    expect(msg).toContain("5,000 PDFs");
    expect(msg).toContain("needs about");
    expect(msg).toContain("55 GB is free after keeping 5.0 GB in reserve");
    expect(msg).toContain("/data/locus");
    expect(msg).toMatch(/Free up about .* GB, or set LOCUS_DATA_DIR/);
  });

  it("the reserve counts: exactly-free space is not enough", () => {
    const plan = planSpace({ files: 1, pdfBytes: GB, ratio: 1, freeBytes: 10 * GB, reserveBytes: 10 * GB });
    expect(plan.fits).toBe(false);
  });

  it("what the index already uses is not counted twice (a restart partway through)", () => {
    const fresh = planSpace({ files: 10, pdfBytes: 10 * GB, freeBytes: 12 * GB, reserveBytes: GB });
    const half = planSpace({ files: 10, pdfBytes: 10 * GB, freeBytes: 12 * GB, reserveBytes: GB, indexBytes: fresh.estimateBytes / 2 });
    expect(half.remainingBytes).toBeCloseTo(fresh.estimateBytes / 2, -2);
    expect(half.fits).toBe(true);
  });

  it("the ratio is refined from the index built so far, once there is enough of it to judge", () => {
    expect(observedRatio(1e9, 1e9, 5)).toBeNull(); // too few files
    expect(observedRatio(1e9, 1e6, 100)).toBeNull(); // too few bytes
    expect(observedRatio(2 * GB, 4 * GB, 50)).toBeCloseTo(0.5);
    const refined = planSpace({ files: 100, pdfBytes: 10 * GB, ratio: 0.5, freeBytes: 100 * GB, reserveBytes: GB });
    const dflt = planSpace({ files: 100, pdfBytes: 10 * GB, freeBytes: 100 * GB, reserveBytes: GB });
    expect(refined.estimateBytes).toBeLessThan(dflt.estimateBytes);
  });
});
