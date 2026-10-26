import path from "node:path";
import { resolveAllowed } from "../allowedRoots";
import type { LibraryConfig } from "../config";
import { buildQuery, checkColumns, checkHost, checkPort, DEFAULT_PORTS, FormError, parseConnectionString, splitTable } from "./db/form";
import type { Dialect } from "./db/sql";
import { cleanName, type DatabaseConfig, type DriveConfig, type FolderConfig, type SourceConfig, type SourceKind } from "./forms";
import { parseDriveLink } from "./gdriveLink";

/**
 * What the Sources page sends, turned into the registry's settings (or a
 * plain-language reason it can't be). Used by Add and by Test, so a source
 * that tests fine is one that adds fine. Every path is resolved on the
 * server inside the allowed roots; nothing the browser says about a path is
 * trusted, and the password is split off here so it never joins the config.
 */

export type ParsedSource =
  | { ok: true; kind: SourceKind; name: string; config: SourceConfig; secret?: string }
  | { ok: false; error: string };

const fail = (error: string): ParsedSource => ({ ok: false, error });
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parseSourceInput(body: unknown, cfg: Pick<LibraryConfig, "allowedRoots" | "dataDir">): ParsedSource {
  if (typeof body !== "object" || body === null) return fail("Send the source's settings as JSON.");
  const b = body as Record<string, unknown>;
  try {
    switch (b.kind) {
      case "folder":
        return parseFolder(b, cfg);
      case "database":
        return parseDatabase(b, cfg);
      case "drive":
        return parseDrive(b);
      default:
        return fail('`kind` must be "folder", "database" or "drive".');
    }
  } catch (err) {
    if (err instanceof FormError) return fail(err.message);
    throw err;
  }
}

function named(b: Record<string, unknown>, fallback: string): { ok: true; name: string } | { ok: false; message: string } {
  return cleanName(text(b.name) === "" ? fallback : b.name);
}

function parseFolder(b: Record<string, unknown>, cfg: Pick<LibraryConfig, "allowedRoots" | "dataDir">): ParsedSource {
  const check = resolveAllowed(b.path, { roots: cfg.allowedRoots, dataDir: cfg.dataDir });
  if (!check.ok) return fail(check.message);
  const name = named(b, path.basename(check.real) || "Folder");
  if (!name.ok) return fail(name.message);
  const config: FolderConfig = { path: check.real };
  return { ok: true, kind: "folder", name: name.name, config };
}

function parseDrive(b: Record<string, unknown>): ParsedSource {
  const link = parseDriveLink(b.link);
  if (!link.ok) return fail(link.message);
  const name = named(b, "Google Drive folder");
  if (!name.ok) return fail(name.message);
  const config: DriveConfig = { folderId: link.folderId, link: link.link };
  return { ok: true, kind: "drive", name: name.name, config };
}

function parseDatabase(b: Record<string, unknown>, cfg: Pick<LibraryConfig, "allowedRoots" | "dataDir">): ParsedSource {
  let dialect = b.dialect;
  let host = text(b.host);
  let port: unknown = b.port;
  let database = text(b.database);
  let user = text(b.user);
  let password = typeof b.password === "string" && b.password !== "" ? b.password : null;

  // A pasted connection string fills the same fields; it is not kept.
  const pasted = text(b.connectionString);
  if (pasted !== "") {
    const p = parseConnectionString(pasted);
    dialect = p.dialect;
    host = p.host;
    port = p.port;
    database = p.database;
    user = p.user;
    password = p.password ?? password;
  }
  if (dialect !== "sqlite" && dialect !== "postgres" && dialect !== "mysql") return fail("Choose the database type (SQLite, PostgreSQL or MySQL).");
  const d: Dialect = dialect;

  let file: string | undefined;
  if (d === "sqlite") {
    const check = resolveAllowed(b.file, { roots: cfg.allowedRoots, dataDir: cfg.dataDir, want: "file" });
    if (!check.ok) return fail(`Database file: ${check.message}`);
    file = check.real;
  } else {
    host = checkHost(host);
    port = checkPort(port, DEFAULT_PORTS[d]);
    if (database === "") return fail("Enter the database name.");
  }

  const { schema: tableSchema, table } = splitTable(b.table);
  const columns = checkColumns((b.columns ?? {}) as Record<string, unknown>);
  const content = b.content;
  if (content !== "file_path" && content !== "file_bytes") return fail("Say whether the content column holds a file path or the file itself.");

  const config: DatabaseConfig = {
    dialect: d,
    ...(d === "sqlite" ? { file } : { host, port: port as number, database, ...(user ? { user } : {}) }),
    ...(text(b.schema) !== "" || tableSchema ? { schema: text(b.schema) || tableSchema } : {}),
    table,
    columns,
    content,
    hasPassword: password !== null && d !== "sqlite",
  };
  buildQuery(config); // validates every identifier before anything is saved
  const name = named(b, `${d === "sqlite" ? path.basename(file!) : database} · ${table}`);
  if (!name.ok) return fail(name.message);
  return { ok: true, kind: "database", name: name.name, config, ...(config.hasPassword ? { secret: password! } : {}) };
}
