import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Sliding window: a session is extended by this much on activity… */
export const SESSION_SLIDING_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** …but never beyond SESSION_ABSOLUTE_MS after creation. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Throttle sliding updates to at most one DB write per minute. */
const SLIDE_THROTTLE_MS = 60 * 1000;

export const SESSION_COOKIE_NAME = "__Host-cw_session";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "user";
}

interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

interface ValidatedSession {
  user: SessionUser;
  tokenHash: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

function isExpiryThresholdEnabled(): boolean {
  return true;
}

function parseIso(d: string): number {
  return Date.parse(d);
}

/** Generate a fresh 32-byte base64url token (256 bits of entropy). */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createSession(
  db: DatabaseSync,
  opts: {
    userId: string;
    userAgent?: string | null;
    ip?: string | null;
    now?: Date;
  },
): string {
  const now = opts.now ?? new Date();
  const token = generateToken();
  const expires = new Date(
    Math.min(now.getTime() + SESSION_SLIDING_MS, now.getTime() + SESSION_ABSOLUTE_MS),
  );
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    opts.userId,
    now.toISOString(),
    now.toISOString(),
    expires.toISOString(),
    opts.userAgent ?? null,
    opts.ip ?? null,
  );
  return token;
}

/**
 * Validate a raw token. Returns the user + session metadata, or null if the
 * token is unknown, expired, or belongs to a disabled/deleted user.
 * Slides the expiry forward when the last slide is older than a minute.
 */
export function validateSession(
  db: DatabaseSync,
  token: string,
  now: Date = new Date(),
): ValidatedSession | null {
  if (!token || token.length < 20 || token.length > 128) return null;
  const tokenHash = hashToken(token);

  const row = db
    .prepare(
      `SELECT s.token_hash, s.user_id, s.created_at, s.last_seen_at, s.expires_at,
              u.id AS u_id, u.username, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | (SessionRow & {
        u_id: string;
        username: string;
        role: "admin" | "user";
        disabled: number;
      })
    | undefined;

  if (!row) return null;
  if (row.disabled) return null;

  const expiresMs = parseIso(row.expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return null;

  const createdAtMs = parseIso(row.created_at);
  const absoluteExpiresAt = new Date(createdAtMs + SESSION_ABSOLUTE_MS);
  // Absolute cap: even a recently-slid session dies 30 days after creation.
  if (absoluteExpiresAt.getTime() <= now.getTime()) return null;

  // Slide at most once per minute to keep write volume negligible.
  const lastSeenMs = parseIso(row.last_seen_at);
  if (
    isExpiryThresholdEnabled() &&
    now.getTime() - lastSeenMs >= SLIDE_THROTTLE_MS
  ) {
    const newExpiry = Math.min(
      now.getTime() + SESSION_SLIDING_MS,
      createdAtMs + SESSION_ABSOLUTE_MS,
    );
    db.prepare(
      "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
    ).run(now.toISOString(), new Date(newExpiry).toISOString(), tokenHash);
  }

  return {
    user: { id: row.u_id, username: row.username, role: row.role },
    tokenHash,
    expiresAt: new Date(expiresMs),
    absoluteExpiresAt,
  };
}

/** Invalidate the old token and issue a fresh one for the same user. */
export function rotateSession(
  db: DatabaseSync,
  oldToken: string,
  opts: { userAgent?: string | null; ip?: string | null; now?: Date } = {},
): string {
  const validated = validateSession(db, oldToken, opts.now ?? new Date());
  if (!validated) {
    throw new Error("cannot rotate an invalid session");
  }
  revokeSession(db, oldToken);
  return createSession(db, {
    userId: validated.user.id,
    userAgent: opts.userAgent,
    ip: opts.ip,
    now: opts.now,
  });
}

export function revokeSession(db: DatabaseSync, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function revokeAllForUser(db: DatabaseSync, userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
