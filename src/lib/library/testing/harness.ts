/**
 * Test-only: runs the library indexer in its own process, set up exactly as
 * scripts/index-library.ts sets it up (prepareProcessForLibraryRun, the
 * writer lock), except that the external-drive check is replaced by a fake
 * guard, because tests can't plug in a drive. Lets tests SIGKILL a real
 * indexer mid-run and watch what a run writes, and where.
 *
 *   tsx harness.ts <libraryDir> <dataDir> [configOverridesJson]
 */
import fs from "node:fs";
import { LibraryIndexer } from "../pipeline";
import { acquireLock, prepareProcessForLibraryRun } from "../run";
import { FolderSource } from "../sources/folder";
import { fakeGuard, testConfig } from "./helpers";

async function main() {
  const [libraryDir, dataDir, overrides] = process.argv.slice(2);
  const config = testConfig(overrides ? JSON.parse(overrides) : {});
  const guard = fakeGuard(dataDir);
  prepareProcessForLibraryRun(guard.paths);
  const release = acquireLock(guard.paths.lock);
  const indexer = new LibraryIndexer({
    config,
    guard,
    sources: [
      new FolderSource(libraryDir, {
        include: config.include,
        exclude: config.exclude,
        crossDevice: false,
        maxFileBytes: config.maxFileBytes,
        settleSeconds: config.settleSeconds,
      }),
    ],
    log: (line) => console.log(line),
    idlePollMs: 20,
  });
  const p = await indexer.run();
  release();
  fs.writeSync(1, `DONE ${JSON.stringify({ indexed: p.filesIndexed, unchanged: p.filesUnchanged, pages: p.pagesDone })}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
