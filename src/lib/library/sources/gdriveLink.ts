/**
 * Turning what someone pastes into a Google Drive folder id. Only the folder
 * id is kept; the canonical link is rebuilt from it.
 */

const ID = /^[A-Za-z0-9_-]{10,100}$/;

export type DriveLink = { ok: true; folderId: string; link: string } | { ok: false; message: string };

export const canonicalFolderLink = (folderId: string) => `https://drive.google.com/drive/folders/${folderId}`;

export function parseDriveLink(input: unknown): DriveLink {
  const bad = (message: string): DriveLink => ({ ok: false, message });
  if (typeof input !== "string" || input.trim() === "") return bad("Paste the Google Drive folder link.");
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("That doesn't look like a Google Drive folder link.");
  }
  if (url.protocol !== "https:" || url.hostname !== "drive.google.com") {
    return bad("That doesn't look like a Google Drive folder link (it should start with https://drive.google.com/).");
  }
  if (/\/file\/d\//.test(url.pathname)) return bad("That's a link to a single file. Paste a link to a folder.");

  // /drive/folders/<id>, /drive/u/0/folders/<id>, /drive/mobile/folders/<id>
  const m = url.pathname.match(/\/folders\/([^/?#]+)/);
  const id = m ? m[1] : (url.pathname === "/open" || url.pathname === "/folderview" ? url.searchParams.get("id") : null);
  if (!id || !ID.test(id)) return bad("That doesn't look like a Google Drive folder link.");
  return { ok: true, folderId: id, link: canonicalFolderLink(id) };
}
