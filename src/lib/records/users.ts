import type Database from "better-sqlite3";
import { constantTimeEqual } from "../auth";
import { ADMIN_USERNAME, adminPasscode } from "../users/mode";
import { checkPasscodeStrength, dummyHash, generatePasscode, hashPasscode, verifyPasscode } from "./passcodes";

/**
 * Accounts. A user is a username and a passcode (scrypt-hashed); the admin
 * is the built-in `admin` account, whose passcode is LOCUS_ADMIN_PASSCODE
 * in .env.local (not chosen or changed in the app). Disabling a user or
 * resetting a passcode bumps `token_version`, which signs that user out of
 * every device at their next request.
 */

export type Role = "user" | "admin";

export interface UserRow {
  id: number;
  username: string;
  role: Role;
  tokenVersion: number;
  createdAt: string;
  createdBy: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

interface Raw {
  id: number;
  username: string;
  role: Role;
  passcode_hash: string | null;
  token_version: number;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

const toUser = (r: Raw): UserRow => ({
  id: r.id,
  username: r.username,
  role: r.role,
  tokenVersion: r.token_version,
  createdAt: r.created_at,
  createdBy: r.created_by,
  lastLoginAt: r.last_login_at,
  disabledAt: r.disabled_at,
});

const now = () => new Date().toISOString();

export class UserError extends Error {
  constructor(
    readonly code: "invalid-username" | "taken" | "weak-passcode" | "not-found" | "reserved" | "wrong-passcode",
    message: string
  ) {
    super(message);
  }
}

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]$/;

export function checkUsername(raw: unknown): string {
  if (typeof raw !== "string") throw new UserError("invalid-username", "Choose a username.");
  const name = raw.trim();
  if (!USERNAME.test(name)) {
    throw new UserError("invalid-username", "Usernames are 3-32 characters: letters, digits, dots, dashes and underscores, starting and ending with a letter or digit.");
  }
  if (name.toLowerCase() === ADMIN_USERNAME) throw new UserError("reserved", "That username is reserved.");
  return name;
}

export function getUser(db: Database.Database, id: number): UserRow | null {
  const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Raw | undefined;
  return r ? toUser(r) : null;
}

export function findUserByName(db: Database.Database, username: string): UserRow | null {
  const r = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Raw | undefined;
  return r ? toUser(r) : null;
}

export async function createUser(
  db: Database.Database,
  input: { username: unknown; passcode: unknown; createdBy: "signup" | "admin" }
): Promise<UserRow> {
  const username = checkUsername(input.username);
  const strength = checkPasscodeStrength(input.passcode, username);
  if (!strength.ok) throw new UserError("weak-passcode", strength.message);
  const hash = await hashPasscode(input.passcode as string);
  try {
    const id = Number(
      db.prepare("INSERT INTO users (username, role, passcode_hash, created_at, created_by) VALUES (?, 'user', ?, ?, ?)").run(username, hash, now(), input.createdBy).lastInsertRowid
    );
    return getUser(db, id)!;
  } catch (err) {
    if (String((err as { code?: string }).code).startsWith("SQLITE_CONSTRAINT")) throw new UserError("taken", "That username is already taken.");
    throw err;
  }
}

/** Creates an account with a generated passcode; the passcode is returned once and never stored in the clear. */
export async function createUserWithGeneratedPasscode(db: Database.Database, username: unknown): Promise<{ user: UserRow; passcode: string }> {
  const passcode = generatePasscode();
  const user = await createUser(db, { username, passcode, createdBy: "admin" });
  return { user, passcode };
}

export type LoginResult = { ok: true; user: UserRow } | { ok: false; reason: "wrong" | "disabled" };

/** Checks a username and passcode. A wrong username and a wrong passcode take the same time and give the same answer. */
export async function verifyLogin(db: Database.Database, username: string, passcode: string): Promise<LoginResult> {
  const raw = db.prepare("SELECT * FROM users WHERE username = ? AND role = 'user'").get(username) as Raw | undefined;
  const ok = await verifyPasscode(passcode, raw?.passcode_hash ?? (await dummyHash()));
  if (!raw || !ok) return { ok: false, reason: "wrong" };
  if (raw.disabled_at) return { ok: false, reason: "disabled" };
  return { ok: true, user: toUser(raw) };
}

export function recordLogin(db: Database.Database, id: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), id);
}

export function setDisabled(db: Database.Database, id: number, disabled: boolean): void {
  const changed = db
    .prepare(disabled ? "UPDATE users SET disabled_at = ?, token_version = token_version + 1 WHERE id = ? AND role = 'user'" : "UPDATE users SET disabled_at = NULL WHERE id = ? AND role = 'user'")
    .run(...(disabled ? [now(), id] : [id])).changes;
  if (changed === 0) throw new UserError("not-found", "No such user.");
}

export async function setPasscode(db: Database.Database, id: number, passcode: string): Promise<void> {
  const user = getUser(db, id);
  if (!user || user.role !== "user") throw new UserError("not-found", "No such user.");
  const strength = checkPasscodeStrength(passcode, user.username);
  if (!strength.ok) throw new UserError("weak-passcode", strength.message);
  db.prepare("UPDATE users SET passcode_hash = ?, token_version = token_version + 1 WHERE id = ?").run(await hashPasscode(passcode), id);
}

/** Admin resets someone's passcode: a new generated one, shown once. Signs them out. */
export async function resetPasscode(db: Database.Database, id: number): Promise<string> {
  const passcode = generatePasscode();
  await setPasscode(db, id, passcode);
  return passcode;
}

/** A user changing their own passcode (must know the current one). Other devices are signed out; the caller gets the new token version. */
export async function changeOwnPasscode(db: Database.Database, id: number, current: string, next: string): Promise<number> {
  const raw = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(id) as Raw | undefined;
  if (!raw?.passcode_hash || !(await verifyPasscode(current, raw.passcode_hash))) throw new UserError("wrong-passcode", "That isn't your current password.");
  await setPasscode(db, id, next);
  return getUser(db, id)!.tokenVersion;
}

export interface UserSummary extends UserRow {
  sessions: number;
  uploads: number;
  uploadBytes: number;
  searches30d: number;
}

export function listUsers(db: Database.Database): UserSummary[] {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = db.prepare("SELECT * FROM users ORDER BY role DESC, username COLLATE NOCASE").all() as Raw[];
  const sessions = db.prepare("SELECT count(*) FROM conversation_owners WHERE user_id = ?").pluck();
  const uploads = db.prepare("SELECT count(*), coalesce(sum(size_bytes), 0) FROM uploads WHERE user_id = ? AND status = 'ready'").raw();
  const searches = db.prepare("SELECT count(*) FROM activity WHERE user_id = ? AND kind = 'search' AND at >= ?").pluck();
  return rows.map((r) => {
    const [n, bytes] = uploads.get(r.id) as [number, number];
    return { ...toUser(r), sessions: Number(sessions.get(r.id)), uploads: n, uploadBytes: bytes, searches30d: Number(searches.get(r.id, since)) };
  });
}

/** Total bytes of a user's live uploads (for the per-user limit). */
export function userUploadBytes(db: Database.Database, userId: number): number {
  return Number(db.prepare("SELECT coalesce(sum(size_bytes), 0) FROM uploads WHERE user_id = ? AND status = 'ready'").pluck().get(userId));
}

/**
 * Removes a user and the records that belong to them; returns the session
 * ids they owned, so the caller can delete those sessions' files. The
 * activity history stays (it keeps the username).
 */
export function removeUser(db: Database.Database, id: number): string[] {
  const user = getUser(db, id);
  if (!user || user.role !== "user") throw new UserError("not-found", "No such user.");
  return db.transaction(() => {
    const sessions = db.prepare("SELECT conversation_id FROM conversation_owners WHERE user_id = ?").pluck().all(id) as string[];
    db.prepare("DELETE FROM uploads WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM conversation_owners WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return sessions;
  })();
}

// --- the admin account ----------------------------------------------------------

let adminChecked: string | null = null;

/**
 * The built-in admin account, made on first use. Its passcode is
 * LOCUS_ADMIN_PASSCODE: if that changes, every admin sign-in is
 * invalidated (token version bumped) the next time this runs.
 */
export async function ensureAdminUser(db: Database.Database): Promise<UserRow> {
  const passcode = adminPasscode();
  let raw = db.prepare("SELECT * FROM users WHERE role = 'admin'").get() as Raw | undefined;
  if (!raw) {
    db.prepare("INSERT INTO users (username, role, passcode_hash, created_at, created_by) VALUES (?, 'admin', NULL, ?, 'env')").run(ADMIN_USERNAME, now());
    raw = db.prepare("SELECT * FROM users WHERE role = 'admin'").get() as Raw;
  }
  if (passcode !== null && adminChecked !== `${raw.id}:${passcode}`) {
    const same = raw.passcode_hash !== null && (await verifyPasscode(passcode, raw.passcode_hash));
    if (!same) {
      db.prepare("UPDATE users SET passcode_hash = ?, token_version = token_version + 1 WHERE id = ?").run(await hashPasscode(passcode), raw.id);
      raw = db.prepare("SELECT * FROM users WHERE id = ?").get(raw.id) as Raw;
    }
    adminChecked = `${raw.id}:${passcode}`;
  }
  return toUser(raw);
}

/** Constant-time comparison of a typed admin passcode with LOCUS_ADMIN_PASSCODE. */
export function adminPasscodeMatches(typed: string): boolean {
  const configured = adminPasscode();
  return configured !== null && constantTimeEqual(typed.normalize("NFKC"), configured.normalize("NFKC"));
}

export function _resetAdminCheckForTests(): void {
  adminChecked = null;
}
