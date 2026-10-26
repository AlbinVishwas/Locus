import { describe, expect, it } from "vitest";
import { readPick } from "./folderScope";
import { folderSessionId } from "./uploads/folders";

function file(rel: string, type = ""): File {
  const f = new File(["x"], rel.split("/").pop() as string, { type });
  Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
}

describe("readPick", () => {
  it("keeps PDFs at any depth, names the folder, and counts everything else as skipped", () => {
    const pick = readPick([
      file("Pack/b.pdf", "application/pdf"),
      file("Pack/Annex/a.PDF"),
      file("Pack/notes.txt"),
      file("Pack/photo.jpg"),
      file("Pack/.hidden.pdf"),
    ]);
    expect(pick?.name).toBe("Pack");
    expect(pick?.pdfs.map((p) => p.path)).toEqual(["Annex/a.PDF", "b.pdf"]);
    expect(pick?.skipped).toBe(3);
  });

  it("returns null when nothing was picked", () => {
    expect(readPick([])).toBeNull();
  });
});

describe("folderSessionId", () => {
  it("is stable per account and folder, and differs between accounts and folders", () => {
    const id = folderSessionId(1, "Pack");
    expect(id).toBe(folderSessionId(1, "Pack"));
    expect(id).not.toBe(folderSessionId(2, "Pack"));
    expect(id).not.toBe(folderSessionId(1, "Other"));
    expect(id).toMatch(/^fld_[0-9a-f]{32}$/);
  });
});
