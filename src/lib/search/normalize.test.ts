import { describe, expect, it } from "vitest";
import {
  codePointLength,
  foldCase,
  loosen,
  loosenWithOffsets,
  normalizeText,
  searchableText,
} from "./normalize";

describe("normalizeText", () => {
  it("collapses line breaks and runs of whitespace to one space", () => {
    expect(normalizeText("earnest money\n  deposit\r\n\tis due\f")).toBe(
      "earnest money deposit is due"
    );
  });

  it("folds compatibility characters such as ligatures and fullwidth digits", () => {
    expect(normalizeText("ﬁnal ｓｐｅｃ １２")).toBe("final spec 12");
  });

  it("treats every dash variant as the ASCII hyphen", () => {
    expect(normalizeText("26\u20132080 26\u20142080 26\u20112080 26\u22122080")).toBe(
      "26-2080 26-2080 26-2080 26-2080"
    );
  });

  it("removes invisible characters that PDFs scatter inside words", () => {
    expect(normalizeText("ten\u00ADder\u200B no\uFEFF")).toBe("tender no");
  });

  it("keeps the slash and the hyphen distinct", () => {
    expect(normalizeText("26/2080")).not.toBe(normalizeText("26-2080"));
  });
});

describe("foldCase", () => {
  it("lowercases", () => {
    expect(foldCase("Earnest MONEY")).toBe("earnest money");
  });

  it("never changes the length, so match offsets line up with the original", () => {
    const text = "İSTANBUL Tender";
    expect(foldCase(text)).toHaveLength(text.length);
  });
});

describe("loose mode", () => {
  it("makes punctuation variants equal", () => {
    const variants = ["26-2080", "26/2080", "26 2080", "26.2080", "26 / 2080"];
    const loose = variants.map((v) => searchableText(v, "loose"));
    expect(new Set(loose)).toEqual(new Set(["26 2080"]));
  });

  it("keeps non-Latin letters and digits", () => {
    expect(loosen(foldCase("निविदा-संख्या 12"))).toBe("निविदा संख्या 12");
  });

  it("maps each loose character back to its position in the input", () => {
    const input = "a/b-c";
    const { text, offsets } = loosenWithOffsets(input);
    expect(text).toBe("a b c");
    expect([...text].map((_, i) => input[offsets[i]])).toEqual(["a", "/", "b", "-", "c"]);
  });
});

describe("codePointLength", () => {
  it("counts characters as SQLite does, not UTF-16 units", () => {
    expect(codePointLength("a😀")).toBe(2);
  });
});
