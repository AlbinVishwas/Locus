import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { appDir } from "../appDir";
import { activityRetentionDays } from "../users/mode";

/**
 * The records database (data/app/records.db by default, LOCUS_APP_DB_PATH to
 * move it): the users, who owns which session, a history of uploads, and the
 * activity log the admin reads. It lives in the app's own folder, not with
 * the library, so signing in keeps working if the library's drive is
 * unplugged. The app is its main writer; the indexer worker only appends
 * activity rows.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  -- NULL until set; for the admin account it hashes the current LOCUS_ADMIN_PASSCODE (to notice it changing).
  passcode_hash TEXT,
  -- Sign-in tokens carry this; bumping it (disable, passcode reset) signs the user out everywhere.
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  last_login_at TEXT,
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS conversation_owners (
  conversation_id TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  last_used_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_owners_user ON conversation_owners(user_id);

CREATE TABLE IF NOT EXISTS uploads (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL,
  doc_id          INTEGER,
  filename        TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  sha256          TEXT,
  page_count      INTEGER,
  status          TEXT NOT NULL CHECK (status IN ('ready','failed','deleted')),
  error           TEXT,
  uploaded_at     TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS uploads_user ON uploads(user_id, uploaded_at);
CREATE INDEX IF NOT EXISTS uploads_doc ON uploads(conversation_id, doc_id);

-- No foreign key on user_id: the history outlives a removed user (username is kept alongside).
CREATE TABLE IF NOT EXISTS activity (
  id               INTEGER PRIMARY KEY,
  at               TEXT NOT NULL,
  user_id          INTEGER,
  username         TEXT,
  role             TEXT,
  kind             TEXT NOT NULL,
  scope            TEXT,
  query_text       TEXT,
  result_pages     INTEGER,
  result_documents INTEGER,
  took_ms          REAL,
  status           TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','denied','refused')),
  message          TEXT,
  ip               TEXT,
  user_agent       TEXT,
  details          TEXT
);
CREATE INDEX IF NOT EXISTS activity_at ON activity(at DESC);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_kind ON activity(kind, at DESC);
CREATE INDEX IF NOT EXISTS activity_status ON activity(status, at DESC);
`;

export function recordsDbPath(): string {
  const configured = process.env.LOCUS_APP_DB_PATH?.trim();
  // turbopackIgnore: a runtime path; see appDir.ts.
  return configured ? path.resolve(/*turbopackIgnore: true*/ configured) : path.join(appDir(), "records.db");
}

export function openRecordsDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const isNew = !fs.existsSync(file);
  const db = new Database(file);
  if (isNew) db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

let cached: { file: string; db: Database.Database } | null = null;
let retentionTimer: ReturnType<typeof setInterval> | null = null;

/** Deletes activity older than the retention period (default 365 days). */
export function purgeActivity(db: Database.Database, days = activityRetentionDays(), now = Date.now()): number {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const removed = db.prepare("DELETE FROM activity WHERE at < ?").run(cutoff).changes;
  if (removed > 0) db.pragma("incremental_vacuum");
  return removed;
}

export function getRecordsDb(): Database.Database {
  const file = recordsDbPath();
  if (cached && cached.file === file) return cached.db;
  cached?.db.close();
  const db = openRecordsDb(file);
  cached = { file, db };
  if (!retentionTimer) {
    const run = () => {
      try {
        if (cached) purgeActivity(cached.db);
      } catch (err) {
        console.error("[records] activity purge failed", err instanceof Error ? err.message : err);
      }
    };
    run();
    retentionTimer = setInterval(run, 60 * 60 * 1000);
    retentionTimer.unref();
  }
  return db;
}

/** Test-only. */
export function _resetRecordsDbForTests(): void {
  cached?.db.close();
  cached = null;
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}
