import type { DatabaseSync } from "node:sqlite";

/**
 * Numbered migrations, applied in one transaction each, tracked in `meta`.
 * A migration is an array of SQL statements (node:sqlite exec is
 * multi-statement safe inside a transaction).
 */
const MIGRATIONS: { version: number; name: string; statements: string[] }[] = [
  {
    version: 1,
    name: "initial schema",
    statements: [
      // Local authorization mirror of the Clerk user. The id is Clerk's user
      // id (`user_...`), so no secondary mapping table is needed. Credentials
      // are never stored here — Clerk owns passwords, MFA and sessions.
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      `CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'claude',
        title TEXT,
        cli_session_id TEXT,
        model TEXT,
        cwd TEXT,
        policy_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      `CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at)`,
      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      `CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at)`,
      `CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'ok', 'error')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      `CREATE INDEX idx_tool_calls_conversation ON tool_calls(conversation_id, created_at)`,
      `CREATE TABLE integrations (
        provider TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        version TEXT,
        authed INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT
      )`,
      `CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT NOT NULL,
        detail_json TEXT,
        ip TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
    ],
  },
];

export function migrate(db: DatabaseSync): void {
  // Bootstrap the tracking table itself; migrations may then assume it.
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      for (const sql of m.statements) db.exec(sql);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${String(err)}`);
    }
  }
}
