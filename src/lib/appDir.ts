import path from "node:path";

/**
 * Where Locus keeps its own small state that must survive the library's
 * drive being unplugged: the records database (users, ownership, activity)
 * and a note of where the library lives. Inside the project, under /data
 * (git and Vercel ignore it; next.config.ts keeps it out of build traces).
 */
export function appDir(): string {
  const configured = process.env.LOCUS_APP_DIR?.trim();
  // turbopackIgnore: a runtime path; see indexDb.ts for why the hint is needed.
  return configured ? path.resolve(/*turbopackIgnore: true*/ configured) : path.resolve(/*turbopackIgnore: true*/ process.cwd(), "data/app");
}
