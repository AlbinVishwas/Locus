import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pins the workspace root to this directory. Without it, Turbopack
  // walks up looking for a lockfile, finds none until it's outside this
  // (non-git) project, and warns about the ambiguity on every build.
  turbopack: {
    root: __dirname,
  },
  // data/ holds client tender PDFs and the search index built from them.
  // Never let file tracing copy any of it into a server bundle, whatever a
  // route's code looks like to the tracer. (Shipping an index with a
  // deployment, if ever chosen, would be an explicit include of that one file.)
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
};

export default nextConfig;
