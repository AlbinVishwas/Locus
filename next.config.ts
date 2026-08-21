import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pins the workspace root to this directory. Without it, Turbopack
  // walks up looking for a lockfile, finds none until it's outside this
  // (non-git) project, and warns about the ambiguity on every build.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
