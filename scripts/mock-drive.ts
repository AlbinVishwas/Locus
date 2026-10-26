/**
 * A stand-in for the Google Drive API on a loopback port, for the Sources
 * end-to-end checks:
 *
 *   node --import tsx scripts/mock-drive.ts <drive-tree.json>
 *
 * Prints one JSON line ({"base": "...", "apiKey": "..."}) and then serves
 * until killed. The folder tree comes from sources-env-setup.ts.
 */
import fs from "node:fs";
import { startMockDrive } from "../src/lib/library/testing/mockDrive";

const file = process.argv[2];
if (!file) {
  console.error("usage: mock-drive.ts <drive-tree.json>");
  process.exit(1);
}
async function main() {
  const { tree } = JSON.parse(fs.readFileSync(file, "utf8")) as { tree: Array<Record<string, unknown> & { content?: string }> };
  const files = tree.map((f) => ({ ...f, content: f.content === undefined ? undefined : Buffer.from(f.content, "base64") }));
  const drive = await startMockDrive(files as Parameters<typeof startMockDrive>[0], { apiKey: "mock-drive-key" });
  console.log(JSON.stringify({ base: drive.base, apiKey: drive.apiKey }));
  const stop = () => void drive.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
