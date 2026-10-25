/**
 * Setup for `npm run e2e:library`: builds a small library index from three
 * real tender PDFs into <dataDir>, for a server started with
 * LOCUS_LIBRARY_ENABLED=true and LOCUS_DATA_DIR=<dataDir>.
 *
 *   npm run e2e:library:setup -- <dataDir>
 *
 * Test infrastructure, not a library run: it uses the test harness's
 * stand-in for the external-drive check (there's no drive to check on a
 * dev machine), copies the three PDFs into <dataDir>/source/ in nested
 * folders, indexes them, and writes the marker file the app looks for.
 * Point <dataDir> at a scratch folder and delete it afterwards: it holds
 * text extracted from client documents.
 */
import fs from "node:fs";
import path from "node:path";
import { LibraryIndexer } from "../src/lib/library/pipeline";
import { prepareProcessForLibraryRun } from "../src/lib/library/run";
import { FolderSource } from "../src/lib/library/sources/folder";
import { fakeGuard, testConfig } from "../src/lib/library/testing/helpers";
import { writeMarker } from "../src/lib/library/testing/libraryIndex";

const TENDERS = process.env.TENDERS_DIR ?? path.resolve("data/tenders");
const FILES: Array<[string, string]> = [
  ["26033Terms-2026-09-23-01_20_49.pdf", "Tenders/2026/Trichy/26033Terms-2026-09-23-01_20_49.pdf"],
  ["Bidding_docs-2026-09-16-04_46_27.pdf", "Tenders/2026/Bidding_docs-2026-09-16-04_46_27.pdf"],
  ["5_TCC_Civil_Works_SRGM_Mumbai-Final-2026-09-17-02_15_46.pdf", "Civil Works/Mumbai TCC (final).pdf"],
];

async function main() {
  const dataDir = process.argv[2];
  if (!dataDir) {
    console.error("usage: npm run e2e:library:setup -- <dataDir>");
    process.exit(1);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const source = path.join(dataDir, "source");
  for (const [from, to] of FILES) {
    fs.mkdirSync(path.dirname(path.join(source, to)), { recursive: true });
    fs.copyFileSync(path.join(TENDERS, from), path.join(source, to));
  }
  const guard = fakeGuard(dataDir);
  prepareProcessForLibraryRun(guard.paths);
  const config = testConfig({ ocrLang: "eng+hin", ocrDpi: 300, concurrency: 8, filesInFlight: 3, pageWindow: 20 });
  const indexer = new LibraryIndexer({
    config,
    guard,
    sources: [new FolderSource(source, { include: config.include, exclude: config.exclude, crossDevice: false, maxFileBytes: config.maxFileBytes, settleSeconds: 0 })],
    log: (l) => console.log(`[e2e:library:setup] ${l}`),
  });
  const p = await indexer.run();
  writeMarker(dataDir);
  console.log(`[e2e:library:setup] ${p.filesIndexed} documents, ${p.pagesDone} pages indexed into ${dataDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
