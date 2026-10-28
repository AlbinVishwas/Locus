import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { afterEach, describe, expect, it } from "vitest";
import { hasEnvKey, quoteEnvValue, removeEnvKey, setEnvValue } from "./envFile";

describe(".env.local writing", () => {
  it("replaces a key in place, appends a missing one, keeps comments and other keys", () => {
    let t = "# my settings\nA=1\nB=2\n\nC=3\n";
    t = setEnvValue(t, "B", "two");
    t = setEnvValue(t, "D", "four");
    expect(t).toBe("# my settings\nA=1\nB=two\n\nC=3\nD=four\n");
    expect(hasEnvKey(t, "C")).toBe(true);
    expect(removeEnvKey(t, "A")).not.toMatch(/^A=/m);
    expect(setEnvValue("X=1\nX=2\n", "X", "9")).toBe("X=9\n");
  });

  describe("values read back exactly as written (through the same loader the app uses)", () => {
    let dir = "";
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (k.startsWith("LOCUS_T_")) delete process.env[k];
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    const values = [
      "plain-value_1.2",
      "C:\\Users\\new\\tenders", // backslashes and a \n that must not become a newline
      "\\\\nas01\\share\\new folder\\tenders", // UNC path with a space
      "Z:\\tenders",
      "pa$$word#1 with space",
      "it's \"quoted\" $HOME",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCY+EXAMPLE=",
      "scrypt$16384$8$1$c2FsdA==$aGFzaA==",
      "/Volumes/My Drive/tenders",
    ];
    for (const v of values) {
      it(JSON.stringify(v), () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "locus-env-"));
        fs.writeFileSync(path.join(dir, ".env.local"), setEnvValue("", "LOCUS_T_VALUE", v));
        delete process.env.LOCUS_T_VALUE;
        // Next doesn't read .env.local when NODE_ENV is "test", so load it as the real app does.
        const env = process.env as Record<string, string | undefined>;
        const was = env.NODE_ENV;
        env.NODE_ENV = "production";
        try {
          loadEnvConfig(dir, false, { info: () => {}, error: () => {} }, true);
        } finally {
          env.NODE_ENV = was;
        }
        expect(process.env.LOCUS_T_VALUE).toBe(v);
      });
    }
    it("quoting leaves safe values bare", () => {
      expect(quoteEnvValue("true")).toBe("true");
      expect(quoteEnvValue("/mnt/tenders")).toBe("/mnt/tenders");
      expect(quoteEnvValue("a b")).toBe("'a b'");
    });
  });
});
