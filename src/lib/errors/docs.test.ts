import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderErrorDocs } from "./docs";

describe("docs/errors.md", () => {
  it("matches the error catalog (regenerate with: npm run gen:error-docs)", () => {
    const file = path.resolve(import.meta.dirname, "../../../docs/errors.md");
    expect(fs.readFileSync(file, "utf8")).toBe(renderErrorDocs());
  });
});
