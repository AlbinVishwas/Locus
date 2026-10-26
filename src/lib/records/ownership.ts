import type Database from "better-sqlite3";

/**
 * Who owns each session. A session is a random id the browser holds; the
 * first signed-in user to use an id owns it, and from then on every route
 * that takes the id checks the caller is the owner. The existing session
 * index is not touched: ownership lives beside it, keyed by the same id.
 */

const now = () => new Date().toISOString();

/** Claims `conversationId` for `userId` if nobody owns it yet; returns who owns it. */
export function claimConversation(db: Database.Database, conversationId: string, userId: number): number {
  db.prepare("INSERT OR IGNORE INTO conversation_owners (conversation_id, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)").run(
    conversationId,
    userId,
    now(),
    now()
  );
  const owner = db.prepare("SELECT user_id FROM conversation_owners WHERE conversation_id = ?").pluck().get(conversationId) as number;
  if (owner === userId) db.prepare("UPDATE conversation_owners SET last_used_at = ? WHERE conversation_id = ?").run(now(), conversationId);
  return owner;
}

export function ownerOf(db: Database.Database, conversationId: string): number | null {
  return (db.prepare("SELECT user_id FROM conversation_owners WHERE conversation_id = ?").pluck().get(conversationId) as number | undefined) ?? null;
}

export function releaseConversation(db: Database.Database, conversationId: string): void {
  db.prepare("DELETE FROM conversation_owners WHERE conversation_id = ?").run(conversationId);
}

// --- upload records ---------------------------------------------------------------

export interface UploadRecordInput {
  userId: number;
  conversationId: string;
  docId: number | null;
  filename: string;
  sizeBytes: number;
  sha256: string | null;
  pageCount: number | null;
  status: "ready" | "failed";
  error?: string | null;
}

export function recordUpload(db: Database.Database, u: UploadRecordInput): void {
  db.prepare(
    `INSERT INTO uploads (user_id, conversation_id, doc_id, filename, size_bytes, sha256, page_count, status, error, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(u.userId, u.conversationId, u.docId, u.filename, u.sizeBytes, u.sha256, u.pageCount, u.status, u.error ?? null, now());
}

/** The file was removed: the record stays, marked deleted (it no longer counts toward the user's limit). */
export function markUploadDeleted(db: Database.Database, conversationId: string, docId: number): void {
  db.prepare("UPDATE uploads SET status = 'deleted', deleted_at = ? WHERE conversation_id = ? AND doc_id = ? AND status = 'ready'").run(now(), conversationId, docId);
}

export function markConversationUploadsDeleted(db: Database.Database, conversationId: string): void {
  db.prepare("UPDATE uploads SET status = 'deleted', deleted_at = ? WHERE conversation_id = ? AND status = 'ready'").run(now(), conversationId);
}

export interface UploadRecord {
  id: number;
  conversationId: string;
  filename: string;
  sizeBytes: number;
  pageCount: number | null;
  status: string;
  error: string | null;
  uploadedAt: string;
  deletedAt: string | null;
}

export function listUploadRecords(db: Database.Database, userId: number, limit = 500): UploadRecord[] {
  return db
    .prepare(
      `SELECT id, conversation_id AS conversationId, filename, size_bytes AS sizeBytes, page_count AS pageCount, status, error, uploaded_at AS uploadedAt, deleted_at AS deletedAt
       FROM uploads WHERE user_id = ? ORDER BY uploaded_at DESC, id DESC LIMIT ?`
    )
    .all(userId, limit) as UploadRecord[];
}
