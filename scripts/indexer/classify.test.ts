import { describe, expect, it } from "vitest";
import { inkFraction, isSuspectTextLayer, parsePgm, planPage } from "./classify";
import { createLimiter, run, ToolError } from "./exec";
import { pageRanges } from "./report";

const options = { minTextChars: 30, mixedImageCoverage: 0.3 };
const realText = "The bidder shall submit the earnest money deposit before the due date.";

function pgm(width: number, height: number, fill: number, darkPixels = 0): Buffer {
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "latin1");
  const pixels = Buffer.alloc(width * height, fill);
  for (let i = 0; i < darkPixels; i++) pixels[i] = 0;
  return Buffer.concat([header, pixels]);
}

describe("planPage", () => {
  it("checks for blank, then OCRs, a page with too little text layer", () => {
    expect(planPage("  12 \n", 0, options)).toEqual({ checkBlank: true, ocrReason: "no-text-layer" });
  });

  it("OCRs a text page that is mostly image (a mixed page)", () => {
    expect(planPage(realText, 0.85, options)).toEqual({ checkBlank: false, ocrReason: "image-coverage" });
  });

  it("leaves an ordinary text page alone, even with a small logo", () => {
    expect(planPage(realText, 0.05, options)).toEqual({ checkBlank: false, ocrReason: null });
  });

  it("OCRs a text layer that is symbol soup", () => {
    expect(planPage("#$%&*@!#$%&*@!#$%&*@!#$%&*@!#$%&*@!#$%&", 0, options).ocrReason).toBe(
      "suspect-text-layer"
    );
  });
});

describe("isSuspectTextLayer", () => {
  it("does not flag fill-in lines and bullets on tender forms", () => {
    expect(isSuspectTextLayer("Name: ______________________\nAddress: ..........\n\uF0B7 PAN card")).toBe(false);
  });
});

describe("blank detection", () => {
  it("measures ink as the share of dark pixels", () => {
    expect(inkFraction(parsePgm(pgm(100, 100, 255)))).toBe(0);
    expect(inkFraction(parsePgm(pgm(100, 100, 255, 50)))).toBe(0.005);
  });

  it("rejects something that isn't a PGM image", () => {
    expect(() => parsePgm(Buffer.from("not an image"))).toThrow("PGM");
  });
});

describe("external tools", () => {
  it("kills a process that exceeds its timeout and says so", async () => {
    const error = await run("sleep", ["5"], { timeoutMs: 100 }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error.timedOut).toBe(true);
  });

  it("never runs more tasks at once than the limit", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        })
      )
    );
    expect(peak).toBe(2);
  });
});

describe("pageRanges", () => {
  it("compresses runs", () => {
    expect(pageRanges([3, 4, 5, 9, 11, 12])).toBe("3-5, 9, 11-12");
  });
});
