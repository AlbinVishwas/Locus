import fs from "node:fs";
import path from "node:path";

/**
 * Checks every file-tracing manifest (.next/**\/*.nft.json) that `next
 * build` writes for a reference to anything under data/ -- the client
 * tender PDFs, the search index, the OCR cache, uploaded conversation
 * files. None of it may ever be traced into a deployable bundle (see the
 * comment on outputFileTracingExcludes in next.config.ts, and the one on
 * ensureRetentionScheduleStarted in src/app/api/uploads/route.ts for the
 * one way this actually broke: instrumentation.js gets its own trace file
 * that outputFileTracingExcludes can't reach, which is why cleanup.ts is
 * wired up from a route instead of a Next.js instrumentation hook).
 *
 * Run after `npm run build`. Exits non-zero (and prints exactly what
 * leaked) on any match, so this is meant to gate a deploy, not just warn.
 */

function findNftFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findNftFiles(full));
    else if (entry.name.endsWith(".nft.json")) found.push(full);
  }
  return found;
}

function main() {
  const nextDir = path.resolve(".next");
  const nftFiles = findNftFiles(nextDir);
  if (nftFiles.length === 0) {
    console.error(`No .nft.json files found under ${nextDir}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  let leaked = false;
  for (const file of nftFiles) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { files: string[] };
    const matches = manifest.files.filter((f) => /(^|\/)data\//.test(f));
    if (matches.length > 0) {
      leaked = true;
      console.error(`LEAK: ${path.relative(process.cwd(), file)} traces into data/:`);
      for (const m of matches) console.error(`  ${m}`);
    }
  }

  if (leaked) {
    console.error(`\n${nftFiles.length} trace files checked. At least one references data/.`);
    process.exit(1);
  }
  console.log(`OK: ${nftFiles.length} trace files checked, none reference data/.`);
}

main();
