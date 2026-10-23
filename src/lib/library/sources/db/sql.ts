/**
 * The SQL the database source sends, per dialect. Pure functions, so every
 * statement can be checked without a server.
 *
 * The configured query (LIBRARY_DB_QUERY) is never edited, only wrapped as
 * a subquery, and every value -- the keyset cursor, a row id, a byte offset
 * -- is a bound parameter. The batch size is the one thing written into the
 * SQL text, and only after it's been checked to be a positive integer.
 */

export type Dialect = "sqlite" | "postgres" | "mysql";
export type ContentColumn = "file_path" | "file_bytes";

export interface DbUrl {
  dialect: Dialect;
  /** For sqlite: the database file. */
  file?: string;
}

export function parseDbUrl(url: string): DbUrl {
  const lower = url.toLowerCase();
  if (lower.startsWith("sqlite:")) {
    // sqlite:///abs/path.db, sqlite:/abs/path.db, sqlite:relative.db
    const rest = url.slice("sqlite:".length).replace(/^\/\/(?=\/)/, "");
    if (!rest) throw new Error("LIBRARY_DB_URL: sqlite: needs a file path, e.g. sqlite:///Volumes/data/docs.db");
    return { dialect: "sqlite", file: decodeURIComponent(rest) };
  }
  if (lower.startsWith("postgres://") || lower.startsWith("postgresql://")) return { dialect: "postgres" };
  if (lower.startsWith("mysql://")) return { dialect: "mysql" };
  throw new Error(`LIBRARY_DB_URL must start with sqlite:, postgres:// or mysql:// (got ${redactUrl(url)})`);
}

/** The URL with any password replaced by ***, for logs and messages. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@]*):[^@/]*@/i, "$1:***@").replace(/([?&](password|pass|pwd)=)[^&]*/gi, "$1***");
}

/** Removes the URL and its password from any text (a driver's error message, say) before it's logged. */
export function redactSecrets(text: string, url: string | null): string {
  if (!url) return text;
  let out = text.split(url).join(redactUrl(url));
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/:@]*:([^@/]*)@/i);
  if (m && m[1]) {
    for (const form of new Set([m[1], decodeURIComponent(m[1])])) {
      if (form.length >= 3) out = out.split(form).join("***");
    }
  }
  return out;
}

/** The query as given, minus trailing semicolons and whitespace, so it can be wrapped. */
export function wrappableQuery(query: string): string {
  const q = query.trim().replace(/;+\s*$/, "").trim();
  if (q === "") throw new Error("LIBRARY_DB_QUERY is empty");
  if (q.includes(";")) {
    throw new Error("LIBRARY_DB_QUERY must be a single SELECT statement (it contains a ';' before the end)");
  }
  return q;
}

function param(dialect: Dialect, n: number): string {
  return dialect === "postgres" ? `$${n}` : "?";
}

/** Zero rows, every column: what the query returns, to check its columns. */
export function columnsSql(query: string): string {
  return `SELECT * FROM (${wrappableQuery(query)}) AS locus_q WHERE 1 = 0`;
}

function byteLength(dialect: Dialect): string {
  if (dialect === "sqlite") return "length(CAST(locus_q.file_bytes AS BLOB))";
  return "octet_length(locus_q.file_bytes)";
}

/**
 * One batch of the listing, in id order (keyset pagination: the next batch
 * starts after the last id seen). Never selects file_bytes itself -- only
 * its length -- so a batch stays small whatever the files weigh.
 */
export function listSql(dialect: Dialect, query: string, content: ContentColumn, batchSize: number, afterId: boolean): string {
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error(`batch size must be a positive integer, got ${batchSize}`);
  const contentExpr = content === "file_path" ? "locus_q.file_path AS file_path" : `${byteLength(dialect)} AS byte_length`;
  return (
    `SELECT locus_q.id AS id, locus_q.filename AS filename, locus_q.modified_at AS modified_at, ${contentExpr} ` +
    `FROM (${wrappableQuery(query)}) AS locus_q` +
    (afterId ? ` WHERE locus_q.id > ${param(dialect, 1)}` : "") +
    ` ORDER BY locus_q.id LIMIT ${batchSize}`
  );
}

/**
 * One chunk of one row's file_bytes: [offset, offset + length), 1-based
 * offset as all three dialects count. Parameters, in order: offset, length,
 * id.
 */
export function chunkSql(dialect: Dialect, query: string): string {
  const q = wrappableQuery(query);
  const p = (n: number) => param(dialect, n);
  const expr =
    dialect === "sqlite"
      ? `substr(CAST(locus_q.file_bytes AS BLOB), ${p(1)}, ${p(2)})`
      : dialect === "postgres"
        ? `substring(locus_q.file_bytes from ${p(1)} for ${p(2)})`
        : `SUBSTRING(locus_q.file_bytes, ${p(1)}, ${p(2)})`;
  return `SELECT ${expr} AS chunk FROM (${q}) AS locus_q WHERE locus_q.id = ${p(3)}`;
}

/** Statements run right after connecting, to make the session read-only on the server side too. */
export function readOnlySessionSql(dialect: Dialect): string[] {
  if (dialect === "postgres") return ["SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"];
  if (dialect === "mysql") return ["SET SESSION TRANSACTION READ ONLY"];
  return ["PRAGMA query_only = ON"];
}

export function contentColumnOf(columns: string[]): ContentColumn {
  const names = new Set(columns.map((c) => c.toLowerCase()));
  const missing = ["id", "filename", "modified_at"].filter((c) => !names.has(c));
  if (missing.length > 0) {
    throw new Error(`LIBRARY_DB_QUERY must return columns id, filename, modified_at (missing: ${missing.join(", ")})`);
  }
  const hasPath = names.has("file_path");
  const hasBytes = names.has("file_bytes");
  if (hasPath === hasBytes) {
    throw new Error("LIBRARY_DB_QUERY must return exactly one of file_path or file_bytes");
  }
  return hasPath ? "file_path" : "file_bytes";
}

/** modified_at as an ISO string, from whatever the driver returned (Date, string, epoch number). */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "bigint") {
    const n = Number(value);
    // Seconds vs milliseconds since the epoch.
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const s = String(value);
  const d = new Date(s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}
