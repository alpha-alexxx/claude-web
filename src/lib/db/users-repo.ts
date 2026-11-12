import type { DatabaseSync } from "node:sqlite";

/**
 * Local authorization mirror of Clerk users.
 *
 * Clerk is the identity provider: it owns credentials, MFA, sessions and
 * sign-in UI. This table exists only for what a session token cannot tell us
 * — the user's role and whether the operator has disabled their access — and
 * for the foreign keys that keep conversations per-user.
 *
 * The primary key IS the Clerk user id (`user_...`), so a lookup never needs
 * a second mapping table. No credential material is stored here, ever.
 */

export type Role = "admin" | "user";

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The profile fields we refresh from Clerk on each authenticated request. */
export interface ClerkProfile {
  id: string;
  email: string;
  displayName?: string | null;
}

interface RawRow {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  disabled: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, email, display_name, role, disabled, created_at, updated_at FROM users`;

/**
 * node:sqlite types rows as `Record<string, SQLOutputValue>`, which has no
 * overlap with our column shape, so the narrowing has to go through `unknown`.
 * The column list in SELECT is the guarantee.
 */
function asRaw(row: unknown): RawRow {
  return row as RawRow;
}

function toRow(raw: RawRow): UserRow {
  return {
    id: raw.id,
    email: raw.email,
    displayName: raw.display_name,
    role: raw.role,
    disabled: raw.disabled === 1,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function findUserById(db: DatabaseSync, id: string): UserRow | null {
  const raw = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return raw === undefined ? null : toRow(asRaw(raw));
}

/**
 * Get-or-create the local row for the signed-in Clerk user.
 *
 * The first row ever written becomes `admin` — that preserves the plan's
 * first-run admin semantics now that there is no `/setup` route. Signup
 * closure is a Clerk dashboard setting (README documents it); the rule here
 * is "first user wins", not "everyone is an admin".
 *
 * Profile fields are refreshed on every call so a name/email change in Clerk
 * shows up without a webhook.
 */
export function ensureUser(db: DatabaseSync, profile: ClerkProfile): UserRow {
  const existing = findUserById(db, profile.id);
  const displayName = profile.displayName ?? null;

  if (existing) {
    if (existing.email !== profile.email || existing.displayName !== displayName) {
      db.prepare(
        "UPDATE users SET email = ?, display_name = ?, " +
          "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      ).run(profile.email, displayName, profile.id);
      return findUserById(db, profile.id)!;
    }
    return existing;
  }

  // The admin role is decided IN the INSERT, not by a separate COUNT first:
  // "read the count, then insert" is two statements, and two requests arriving
  // together on a fresh database can both read zero and both become admin. A
  // single statement is atomic in SQLite, so exactly one caller can ever win.
  db.prepare(
    "INSERT INTO users (id, email, display_name, role) " +
      "VALUES (?, ?, ?, CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'admin' ELSE 'user' END)",
  ).run(profile.id, profile.email, displayName);
  return findUserById(db, profile.id)!;
}

export function countUsers(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function listUsers(db: DatabaseSync): UserRow[] {
  const rows = db.prepare(`${SELECT} ORDER BY created_at DESC, email ASC`).all();
  return rows.map((row) => toRow(asRaw(row)));
}

export function setUserDisabled(
  db: DatabaseSync,
  id: string,
  disabled: boolean,
): void {
  db.prepare(
    "UPDATE users SET disabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(disabled ? 1 : 0, id);
}

export function setUserRole(db: DatabaseSync, id: string, role: Role): void {
  db.prepare(
    "UPDATE users SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(role, id);
}

/** Removes local authorization + (via FK cascade) the user's conversations. */
export function deleteUser(db: DatabaseSync, id: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

/** Guard against locking the operator out: is this the last enabled admin? */
export function countEnabledAdmins(db: DatabaseSync): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0",
      )
      .get() as { n: number }
  ).n;
}
