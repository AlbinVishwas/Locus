import fs from "node:fs/promises";
// The "legacy" build is the one meant for Node; the default build expects
// browser globals. Only the indexer imports this — never the Next.js app.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Printed page labels ("i", "ii", "A-1", ...) that a PDF can define in its
 * catalog, independent of physical position. Returns null when the PDF
 * defines none — the common case — or when reading them fails: labels are a
 * nicety, so a problem here is logged by the caller, never fatal.
 */
export async function readPageLabels(
  file: string,
  timeoutMs: number
): Promise<(string | null)[] | null> {
  const data = new Uint8Array(await fs.readFile(file));
  const task = getDocument({ data, verbosity: 0 });
  let timer: NodeJS.Timeout | undefined;
  try {
    const labels = await Promise.race([
      task.promise.then((doc) => doc.getPageLabels()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`page labels timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    // pdf.js returns "" for pages a label range doesn't cover.
    return labels ? labels.map((l) => (l === "" ? null : l)) : null;
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
