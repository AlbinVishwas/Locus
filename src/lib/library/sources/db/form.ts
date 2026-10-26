import type { DatabaseColumns, DatabaseConfig } from "../forms";
import type { Dialect } from "./sql";

/**
 * Turning the Database tab's fields into a connection and a query, safely.
 *
 * The admin types a table and column names, never SQL: every identifier is
 * checked against a strict pattern and then quoted for the dialect, so
 * nothing typed can end the statement, add a clause, or reach a different
 * table. The generated query is only ever wrapped and bound by sql.ts. The
 * password is a separate argument and appears in the connection URL only
 * in memory, at the moment of connecting.
 */

export class FormError extends Error {}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER = 63;

export function checkIdentifier(label: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new FormError(`Enter the ${label}.`);
  const v = value.trim();
  if (v.length > MAX_IDENTIFIER || !IDENTIFIER.test(v)) {
    throw new FormError(`The ${label} can only use letters, digits and underscores, and must start with a letter or underscore (got "${v.slice(0, 40)}").`);
  }
  return v;
}

export function quoteIdent(dialect: Dialect, ident: string): string {
  return dialect === "mysql" ? `\`${ident}\`` : `"${ident}"`;
}

/** "documents" or "public.documents" -> { schema, table }, each checked. */
export function splitTable(raw: unknown): { schema?: string; table: string } {
  if (typeof raw !== "string" || raw.trim() === "") throw new FormError("Enter the table name.");
  const parts = raw.trim().split(".");
  if (parts.length > 2) throw new FormError("The table can be written as table or schema.table.");
  if (parts.length === 2) return { schema: checkIdentifier("schema name", parts[0]), table: checkIdentifier("table name", parts[1]) };
  return { table: checkIdentifier("table name", parts[0]) };
}

export function checkColumns(input: Partial<Record<keyof DatabaseColumns, unknown>>): DatabaseColumns {
  return {
    id: checkIdentifier("ID column", input.id),
    filename: checkIdentifier("file name column", input.filename),
    modified: checkIdentifier("modified time column", input.modified),
    content: checkIdentifier(`file content column`, input.content),
  };
}

/** The SELECT the source runs (before sql.ts wraps and binds it). */
export function buildQuery(config: Pick<DatabaseConfig, "dialect" | "schema" | "table" | "columns" | "content">): string {
  const q = (i: string) => quoteIdent(config.dialect, checkIdentifier("name", i));
  const from = config.schema ? `${q(config.schema)}.${q(config.table)}` : q(config.table);
  const c = config.columns;
  return `SELECT ${q(c.id)} AS id, ${q(c.filename)} AS filename, ${q(c.modified)} AS modified_at, ${q(c.content)} AS ${config.content} FROM ${from}`;
}

export const DEFAULT_PORTS: Record<Exclude<Dialect, "sqlite">, number> = { postgres: 5432, mysql: 3306 };

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9.\-_]*[A-Za-z0-9])?$/;
const IPV6 = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$/;

/** Hosts a database source may not use: link-local and cloud-metadata addresses. Private networks are the point of the feature, so they are allowed. */
export function checkHost(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") throw new FormError("Enter the host.");
  const host = raw.trim();
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const valid = bare.includes(":") ? IPV6.test(bare) : HOSTNAME.test(host);
  if (host.length > 253 || !valid) throw new FormError("That host name isn't valid.");
  if (/^169\.254\./.test(bare) || /^fe80:/.test(bare) || bare === "metadata.google.internal" || /^fd00:ec2::/.test(bare)) {
    throw new FormError("That address is reserved (link-local / cloud metadata) and can't be used as a database host.");
  }
  return host;
}

export function checkPort(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new FormError("The port must be a number from 1 to 65535.");
  return n;
}

/** The connection URL for a server database. The password is put in only here, in memory. */
export function buildUrl(config: Pick<DatabaseConfig, "dialect" | "host" | "port" | "database" | "user" | "file">, password?: string | null): string {
  if (config.dialect === "sqlite") {
    if (!config.file) throw new FormError("Choose the database file.");
    return `sqlite://${config.file}`;
  }
  const host = checkHost(config.host);
  const port = checkPort(config.port, DEFAULT_PORTS[config.dialect]);
  const user = config.user ? encodeURIComponent(config.user) : "";
  const pw = password ? `:${encodeURIComponent(password)}` : "";
  const auth = user ? `${user}${pw}@` : "";
  const db = config.database ? `/${encodeURIComponent(config.database)}` : "";
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${config.dialect}://${auth}${hostPart}:${port}${db}`;
}

export interface ParsedConnection {
  dialect: Exclude<Dialect, "sqlite">;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
}

/** Splits a pasted connection string into the form's fields. The pasted text itself is not kept. */
export function parseConnectionString(raw: string): ParsedConnection {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FormError("That doesn't look like a connection string (expected postgres://user:password@host:5432/database).");
  }
  const scheme = url.protocol.replace(":", "").toLowerCase();
  const dialect = scheme === "postgres" || scheme === "postgresql" ? "postgres" : scheme === "mysql" ? "mysql" : null;
  if (!dialect) throw new FormError("Only postgres:// and mysql:// connection strings can be pasted here.");
  return {
    dialect,
    host: checkHost(decodeURIComponent(url.hostname)),
    port: checkPort(url.port || undefined, DEFAULT_PORTS[dialect]),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : null,
  };
}
