import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same "@/..." import alias as tsconfig.json, so route handlers can be
  // imported by tests exactly as Next.js resolves them.
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "node",
  },
});
