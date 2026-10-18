import path from "node:path";
import { indexPath } from "@/lib/search/indexDb";
import { storageCapBytes } from "@/lib/uploads/config";
import { measureStorageUsage } from "@/lib/uploads/storage";

// Walks the filesystem (fs.readdir/stat) -- Node-only.
export const runtime = "nodejs";

/** Current disk usage (uploads + index + OCR cache) against the configured cap -- what the sidebar's storage indicator shows. */
export async function GET() {
  const usage = await measureStorageUsage(path.dirname(indexPath()));
  return Response.json(
    { usedBytes: usage.totalBytes, capBytes: storageCapBytes() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
