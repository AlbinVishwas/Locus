import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * The library's integration suites run real poppler/tesseract, spawn real
 * indexer processes, build trees of tens of thousands of files, or
 * brute-force check an index. Run in parallel with everything else they
 * starve the CPU and push unrelated tests past their timeouts, so they're
 * their own project: it starts once the rest have finished (groupOrder 1),
 * runs one file at a time, and gets an integration-sized default timeout.
 */
const LIBRARY_INTEGRATION = [
  "src/lib/library/pipeline.test.ts",
  "src/lib/library/resume.test.ts",
  "src/lib/library/extract.test.ts",
  "src/lib/library/inventory.test.ts",
  "src/lib/library/walk.test.ts",
  "src/lib/library/verify.test.ts",
  "scripts/share.test.ts",
];

export default defineConfig({
  // Same "@/..." import alias as tsconfig.json, so route handlers can be
  // imported by tests exactly as Next.js resolves them.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "unit", exclude: [...configDefaults.exclude, ...LIBRARY_INTEGRATION] },
      },
      {
        extends: true,
        test: {
          name: "library-integration",
          include: LIBRARY_INTEGRATION,
          fileParallelism: false,
          testTimeout: 30_000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
