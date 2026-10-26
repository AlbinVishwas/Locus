import { createHmac } from "node:crypto";
import { FOLDER_ID_PREFIX } from "./config";

/**
 * The upload session a picked folder is indexed under: a keyed hash of
 * (account, folder name). The same account picking the same folder again
 * lands on the same index (so nothing is uploaded twice), and nobody else can
 * compute or guess it.
 */
export function folderSessionId(userId: number | null, name: string): string {
  const key = process.env.SESSION_SECRET || "locus-folders";
  return FOLDER_ID_PREFIX + createHmac("sha256", key).update(`${userId ?? 0}\n${name}`).digest("hex").slice(0, 32);
}
