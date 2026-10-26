import type { Dialect } from "./db/sql";

/**
 * What an admin enters for each kind of source, and how it's stored. The
 * non-secret part is JSON in the registry (`config`); a database password
 * is sealed separately (secrets.ts) and appears here only as a flag.
 */

export type SourceKind = "folder" | "database" | "drive";

export interface FolderConfig {
  /** The real path of the folder, resolved inside an allowed root. */
  path: string;
}

export interface DatabaseColumns {
  id: string;
  filename: string;
  modified: string;
  /** The column holding either the file's path or its bytes (see `content`). */
  content: string;
}

export interface DatabaseConfig {
  dialect: Dialect;
  /** postgres / mysql */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** sqlite: the database file, resolved inside an allowed root. */
  file?: string;
  /** Optional schema for `table` (postgres / mysql database name). */
  schema?: string;
  table: string;
  columns: DatabaseColumns;
  content: "file_path" | "file_bytes";
  /** Whether a password is stored (sealed). The password itself is never part of the config. */
  hasPassword: boolean;
}

export interface DriveConfig {
  folderId: string;
  /** What was pasted, normalised to the canonical folder URL. */
  link: string;
  /** The folder's name, learned when the source was tested, for display. */
  folderName?: string;
}

export type SourceConfig = FolderConfig | DatabaseConfig | DriveConfig;

export const MAX_NAME_CHARS = 80;

export function cleanName(raw: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Give the source a name." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, message: "Give the source a name." };
  if (name.length > MAX_NAME_CHARS) return { ok: false, message: `Names are limited to ${MAX_NAME_CHARS} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, message: "That name has characters that aren't allowed." };
  return { ok: true, name };
}
