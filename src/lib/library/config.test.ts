import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetEnvWarningsForTests } from "../env";
import { defaultDataDir, isLibraryEnabled, loadLibraryConfig, searchScope } from "./config";

afterEach(() => {
  vi.restoreAllMocks();
  _resetEnvWarningsForTests();
  delete process.env.LIBRARY_MIN_FREE_GB;
  delete process.env.LOCUS_MIN_FREE_GB;
});

describe("library config defaults", () => {
  it("is off, with the data on this Mac's disk inside the project, a 100 GB cap and a 20 GB reserve", () => {
    expect(isLibraryEnabled({})).toBe(false);
    const c = loadLibraryConfig({});
    expect(c.dataDir).toBe(path.resolve(process.cwd(), "data/locus-data"));
    expect(c.dataDir).toBe(defaultDataDir());
    expect(c.dataDirIsDefault).toBe(true);
    expect(c.maxBytes).toBe(100 * 1024 ** 3);
    expect(c.minFreeBytes).toBe(20 * 1024 ** 3);
    expect(c.allowedRoots).toEqual(["/Volumes"]);
    expect(c.allowExfat).toBe(false);
  });

  it("the default data folder is inside /data, which git and Vercel already ignore", async () => {
    const fs = await import("node:fs");
    expect(fs.readFileSync(".gitignore", "utf8")).toMatch(/^\/data\/?$/m);
    expect(fs.readFileSync(".vercelignore", "utf8")).toMatch(/^\/data$/m);
    expect(path.relative(process.cwd(), defaultDataDir()).startsWith("data" + path.sep)).toBe(true);
  });

  it("settings override the defaults", () => {
    const c = loadLibraryConfig({
      LOCUS_DATA_DIR: "/Volumes/SSD/locus-data",
      LOCUS_LIBRARY_MAX_GB: "50",
      LOCUS_MIN_FREE_GB: "5",
      LOCUS_ALLOWED_ROOTS: "/Volumes, /Users/albin/Tenders",
    });
    expect(c.dataDir).toBe("/Volumes/SSD/locus-data");
    expect(c.dataDirIsDefault).toBe(false);
    expect(c.maxBytes).toBe(50 * 1024 ** 3);
    expect(c.minFreeBytes).toBe(5 * 1024 ** 3);
    expect(c.allowedRoots).toEqual(["/Volumes", "/Users/albin/Tenders"]);
  });

  it("LIBRARY_MIN_FREE_GB still works as the earlier name, with a deprecation warning; the new name wins", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.LIBRARY_MIN_FREE_GB = "7";
    expect(loadLibraryConfig().minFreeBytes).toBe(7 * 1024 ** 3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("LIBRARY_MIN_FREE_GB is deprecated"));
    process.env.LOCUS_MIN_FREE_GB = "9";
    expect(loadLibraryConfig().minFreeBytes).toBe(9 * 1024 ** 3);
  });

  it("rejects nonsense", () => {
    expect(() => loadLibraryConfig({ LOCUS_LIBRARY_MAX_GB: "0" })).toThrow(/LOCUS_LIBRARY_MAX_GB/);
    expect(() => loadLibraryConfig({ LOCUS_MIN_FREE_GB: "-1" })).toThrow(/LOCUS_MIN_FREE_GB/);
    expect(() => loadLibraryConfig({ LOCUS_ALLOWED_ROOTS: "relative/path" })).toThrow(/absolute/);
  });

  it("search scope default is the session; unknown values are refused", () => {
    expect(searchScope({})).toBe("session");
    expect(() => searchScope({ LOCUS_SEARCH_SCOPE: "everything" })).toThrow();
  });

  it('"all" means all sources (the library)', () => {
    expect(searchScope({ LOCUS_SEARCH_SCOPE: "all" })).toBe("library");
    expect(searchScope({ LOCUS_SEARCH_SCOPE: " ALL " })).toBe("library");
  });
});
