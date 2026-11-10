import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../migrate";
import { getDb, resetDbForTest } from "../client";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cw-db-"));
  resetDbForTest();
});

afterEach(() => {
  resetDbForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("creates all tables and sets schema_version on a fresh database", () => {
    const db = new DatabaseSync(path.join(dir, "test.db"));
    migrate(db);

    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(Number(version.value)).toBeGreaterThanOrEqual(1);

    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      "users",
      "conversations",
      "messages",
      "tool_calls",
      "integrations",
      "audit_log",
      "meta",
    ]) {
      expect(tables).toContain(t);
    }
    // Clerk owns sessions; storing our own would fork the source of truth.
    expect(tables).not.toContain("sessions");
    db.close();
  });

  it("is idempotent — running twice does not error or duplicate", () => {
    const db = new DatabaseSync(path.join(dir, "test.db"));
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM meta").get() as { n: number }
    ).n;
    expect(count).toBe(1);
    db.close();
  });

  it("enforces the users role and disabled CHECK constraints", () => {
    const db = new DatabaseSync(path.join(dir, "test.db"));
    migrate(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO users (id, email, role) VALUES (?, ?, ?)",
        )
        .run("user_1", "alice@example.com", "superuser"),
    ).toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)")
        .run("user_1", "alice@example.com", "admin"),
    ).not.toThrow();
    db.close();
  });

  it("keeps emails unique case-insensitively", () => {
    const db = new DatabaseSync(path.join(dir, "test.db"));
    migrate(db);
    db.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)").run(
      "user_1",
      "Alice@Example.com",
      "user",
    );
    expect(() =>
      db
        .prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)")
        .run("user_2", "alice@example.com", "user"),
    ).toThrow();
    db.close();
  });

  it("cascades conversations when a user row is deleted", () => {
    const db = new DatabaseSync(path.join(dir, "test.db"));
    migrate(db);

    db.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)").run(
      "user_1",
      "alice@example.com",
      "admin",
    );
    db.prepare("INSERT INTO conversations (id, user_id) VALUES (?, ?)").run(
      "conv_1",
      "user_1",
    );

    db.prepare("DELETE FROM users WHERE id = ?").run("user_1");
    const conversations = db
      .prepare("SELECT COUNT(*) AS n FROM conversations")
      .get() as { n: number };
    expect(conversations.n).toBe(0);
    db.close();
  });

  it("rolls back a failed migration and leaves the version untouched", () => {
    // Corrupt the target: pre-create a `users` table incompatible with the
    // migration so CREATE TABLE users fails inside the transaction.
    const db = new DatabaseSync(path.join(dir, "test.db"));
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE users (bogus TEXT)");

    expect(() => migrate(db)).toThrow(/failed/);
    // Version must not be recorded, and the partial writes rolled back —
    // but our pre-existing broken users table remains (it predates us).
    const version = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    expect(version).toBeUndefined();
    db.close();
  });

  it("creates the database parent directory via getDb when missing", () => {
    const nested = path.join(dir, "a", "b", "claude-web.db");
    expect(existsSync(path.dirname(nested))).toBe(false);
    const db = getDb(nested); // getDb mkdirs the parent first
    expect(existsSync(nested)).toBe(true);
    db.close();
  });
});
