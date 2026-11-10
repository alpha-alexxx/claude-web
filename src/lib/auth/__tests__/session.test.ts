import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../../db/migrate";
import {
  createSession,
  validateSession,
  rotateSession,
  revokeSession,
  revokeAllForUser,
  hashToken,
} from "../session";
import { randomBytes, createHash, randomUUID } from "node:crypto";

let dir: string;
let db: DatabaseSync;
let userId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cw-sess-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  migrate(db);
  userId = randomUUID();
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')",
  ).run(userId, "alice", "hash");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("token generation", () => {
  it("creates a 32-byte base64url token (no padding, URL-safe)", () => {
    const tok = createSession(db, { userId });
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 chars b64url
  });

  it("stores only the sha256 hash, never the raw token", () => {
    const tok = createSession(db, { userId });
    const rows = db.prepare("SELECT token_hash FROM sessions").all() as {
      token_hash: string;
    }[];
    expect(rows).toHaveLength(1);
    const expected = createHash("sha256").update(tok).digest("hex");
    expect(rows[0].token_hash).toBe(expected);
    // The raw token must not appear anywhere in the DB
    const raw = db
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?")
      .get(tok) as { n: number };
    expect(raw.n).toBe(0);
  });

  it("hashToken is sha256 hex and deterministic", () => {
    const tok = randomBytes(8).toString("hex");
    expect(hashToken(tok)).toBe(
      createHash("sha256").update(tok).digest("hex"),
    );
  });
});

describe("validateSession", () => {
  it("accepts a valid, unexpired token and returns the user", () => {
    const tok = createSession(db, { userId });
    const result = validateSession(db, tok);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(userId);
    expect(result!.user.username).toBe("alice");
  });

  it("rejects a token that was never issued", () => {
    expect(validateSession(db, "bogus-token")).toBeNull();
  });

  it("rejects an expired token", () => {
    const tok = createSession(db, { userId });
    // Force-expire in the DB
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      hashToken(tok),
    );
    expect(validateSession(db, tok)).toBeNull();
  });

  it("rejects a token whose user is disabled", () => {
    const tok = createSession(db, { userId });
    db.prepare("UPDATE users SET disabled = 1 WHERE id = ?").run(userId);
    expect(validateSession(db, tok)).toBeNull();
  });

  it("rejects a token whose user was deleted", () => {
    const tok = createSession(db, { userId });
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    expect(validateSession(db, tok)).toBeNull();
  });

  it("slides last_seen_at / extends expiry at most once per minute", () => {
    const tok = createSession(db, { userId });
    // Set last_seen_at far in the past so the next validate should slide it
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
      old,
      hashToken(tok),
    );

    const before = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(tok)) as { last_seen_at: string; expires_at: string };

    const r1 = validateSession(db, tok);
    expect(r1).not.toBeNull();

    const after = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(tok)) as { last_seen_at: string; expires_at: string };

    expect(after.last_seen_at > before.last_seen_at).toBe(true);

    // A second validate within the same minute must NOT update again
    const after2 = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(tok)) as { last_seen_at: string };
    validateSession(db, tok);
    const after3 = db
      .prepare("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(tok)) as { last_seen_at: string };
    expect(after3.last_seen_at).toBe(after2.last_seen_at);
  });
});

describe("rotation", () => {
  it("rotateSession invalidates the old token and issues a new one bound to the same user", () => {
    const old = createSession(db, { userId });
    const fresh = rotateSession(db, old);
    expect(fresh).not.toBe(old);
    expect(validateSession(db, old)).toBeNull();
    const result = validateSession(db, fresh);
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe(userId);
  });
});

describe("revocation", () => {
  it("revokeSession deletes exactly that session", () => {
    const a = createSession(db, { userId });
    const b = createSession(db, { userId });
    revokeSession(db, a);
    expect(validateSession(db, a)).toBeNull();
    expect(validateSession(db, b)).not.toBeNull();
  });

  it("revokeAllForUser deletes every session for that user only", () => {
    const a = createSession(db, { userId });
    // second user
    const otherId = randomUUID();
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'user')",
    ).run(otherId, "bob", "hash");
    const b = createSession(db, { userId: otherId });

    revokeAllForUser(db, userId);
    expect(validateSession(db, a)).toBeNull();
    expect(validateSession(db, b)).not.toBeNull();
  });
});
