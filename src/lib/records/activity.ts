import type Database from "better-sqlite3";
import { logQueryText } from "../users/mode";

/**
 * The activity log: one row per thing that happened, for the admin to read.
 * Append-only through the app (there is no edit route; only the retention
 * purge deletes). It stores search *text* (when LOCUS_LOG_QUERY_TEXT isn't
 * false) and result *counts* -- never snippets or document text.
 */

export type ActivityKind =
  | "login"
  | "login_failed"
  | "logout"
  | "signup"
  | "signup_failed"
  | "passcode_changed"
  | "search"
  | "search_more"
  | "search_failed"
  | "upload_ready"
  | "upload_failed"
  | "upload_deleted"
  | "session_deleted"
  | "access_denied"
  | "source_added"
  | "source_tested"
  | "source_paused"
  | "source_resumed"
  | "source_rescan"
  | "source_removed"
  | "source_renamed"
  | "user_created"
  | "user_disabled"
  | "user_enabled"
  | "user_passcode_reset"
  | "user_removed"
  | "indexer_paused"
  | "indexer_resumed"
  | "indexer_error"
  | "server_error";

export type ActivityStatus = "ok" | "error" | "denied" | "refused";

export interface ActivityInput {
  userId?: number | null;
  username?: string | null;
  role?: string | null;
  kind: ActivityKind;
  /** "my-uploads", "all-sources", "source:<name>" */
  scope?: string | null;
  queryText?: string | null;
  resultPages?: number | null;
  resultDocuments?: number | null;
  tookMs?: number | null;
  status?: ActivityStatus;
  message?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

const MAX_QUERY = 2000;
const MAX_MESSAGE = 1000;

export function logActivity(db: Database.Database, a: ActivityInput): void {
  try {
    db.prepare(
      `INSERT INTO activity (at, user_id, username, role, kind, scope, query_text, result_pages, result_documents, took_ms, status, message, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      new Date().toISOString(),
      a.userId ?? null,
      a.username ?? null,
      a.role ?? null,
      a.kind,
      a.scope ?? null,
      a.queryText != null && logQueryText() ? a.queryText.slice(0, MAX_QUERY) : null,
      a.resultPages ?? null,
      a.resultDocuments ?? null,
      a.tookMs == null ? null : Math.round(a.tookMs * 10) / 10,
      a.status ?? "ok",
      a.message ? a.message.slice(0, MAX_MESSAGE) : null,
      a.ip ?? null,
      a.userAgent ? a.userAgent.slice(0, 200) : null,
      a.details ? JSON.stringify(a.details) : null
    );
  } catch (err) {
    // Logging must never break the request it describes.
    console.error("[activity] couldn't write a row", err instanceof Error ? err.message : err);
  }
}

/** The caller's address as best it's known: Cloudflare's header, else the last (proxy-added) forwarded entry. */
export function callerIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1].slice(0, 64);
  }
  return null;
}

export interface ActivityFilter {
  userId?: number;
  username?: string;
  kinds?: string[];
  status?: ActivityStatus[];
  /** ISO timestamps. */
  from?: string;
  to?: string;
  /** Substring of the query text or message. */
  text?: string;
  /** Anything that went wrong: status other than ok, or one of the issue kinds. */
  issuesOnly?: boolean;
}

export interface ActivityRow {
  id: number;
  at: string;
  userId: number | null;
  username: string | null;
  role: string | null;
  kind: string;
  scope: string | null;
  queryText: string | null;
  resultPages: number | null;
  resultDocuments: number | null;
  tookMs: number | null;
  status: ActivityStatus;
  message: string | null;
  ip: string | null;
  userAgent: string | null;
  details: string | null;
}

export const ISSUE_KINDS = ["login_failed", "signup_failed", "access_denied", "search_failed", "upload_failed", "indexer_error", "indexer_paused", "server_error"];

function where(f: ActivityFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (f.userId !== undefined) {
    clauses.push("user_id = ?");
    params.push(f.userId);
  }
  if (f.username) {
    clauses.push("username = ? COLLATE NOCASE");
    params.push(f.username);
  }
  if (f.kinds?.length) {
    clauses.push(`kind IN (${f.kinds.map(() => "?").join(",")})`);
    params.push(...f.kinds);
  }
  if (f.status?.length) {
    clauses.push(`status IN (${f.status.map(() => "?").join(",")})`);
    params.push(...f.status);
  }
  if (f.from) {
    clauses.push("at >= ?");
    params.push(f.from);
  }
  if (f.to) {
    clauses.push("at <= ?");
    params.push(f.to);
  }
  if (f.text) {
    clauses.push("(query_text LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')");
    const like = `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  if (f.issuesOnly) {
    clauses.push(`(status != 'ok' OR kind IN (${ISSUE_KINDS.map(() => "?").join(",")}))`);
    params.push(...ISSUE_KINDS);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const COLUMNS = `id, at, user_id AS userId, username, role, kind, scope, query_text AS queryText, result_pages AS resultPages,
  result_documents AS resultDocuments, took_ms AS tookMs, status, message, ip, user_agent AS userAgent, details`;

export function queryActivity(db: Database.Database, f: ActivityFilter, options: { limit?: number; before?: number } = {}): { rows: ActivityRow[]; total: number; nextBefore: number | null } {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const w = where(f);
  const total = Number(db.prepare(`SELECT count(*) FROM activity ${w.sql}`).pluck().get(...w.params));
  // Keyset paging by id (newest first): stable while new rows arrive.
  const paged = options.before !== undefined ? `${w.sql ? w.sql + " AND" : "WHERE"} id < ?` : w.sql;
  const params = options.before !== undefined ? [...w.params, options.before] : w.params;
  const rows = db.prepare(`SELECT ${COLUMNS} FROM activity ${paged} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1) as ActivityRow[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { rows: page, total, nextBefore: more ? page[page.length - 1].id : null };
}

export interface IssueSummary {
  since: string;
  failedSignIns: number;
  deniedAccess: number;
  searchErrors: number;
  uploadFailures: number;
  indexingProblems: number;
  storagePauses: number;
  serverErrors: number;
}

export function summarizeIssues(db: Database.Database, since: string): IssueSummary {
  const n = (kinds: string[]) =>
    Number(db.prepare(`SELECT count(*) FROM activity WHERE at >= ? AND kind IN (${kinds.map(() => "?").join(",")})`).pluck().get(since, ...kinds));
  return {
    since,
    failedSignIns: n(["login_failed", "signup_failed"]),
    deniedAccess: n(["access_denied"]),
    searchErrors: n(["search_failed"]),
    uploadFailures: n(["upload_failed"]),
    indexingProblems: n(["indexer_error"]),
    storagePauses: n(["indexer_paused"]),
    serverErrors: n(["server_error"]),
  };
}

// --- CSV -------------------------------------------------------------------------------

/** Spreadsheet formulas typed into a search box must not run when the export is opened: cells that start with = + - @ (or a tab/return) get a leading apostrophe. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function activityToCsv(rows: ActivityRow[]): string {
  const head = ["time", "user", "role", "event", "scope", "query", "pages", "documents", "took_ms", "status", "message", "address"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([r.at, r.username, r.role, r.kind, r.scope, r.queryText, r.resultPages, r.resultDocuments, r.tookMs, r.status, r.message, r.ip].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
