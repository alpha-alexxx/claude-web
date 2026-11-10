import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Singleton SQLite connection (node:sqlite, synchronous — suits Next.js
 * route handlers; WAL for concurrent readers). Import lazily per-request
 * from route handlers; module state survives across requests in the
 * Node.js server process.
 */
let _db: DatabaseSync | null = null;

export function getDb(databasePath?: string): DatabaseSync {
  if (_db && !databasePath) return _db;
  const p = databasePath ?? process.env.DATABASE_PATH ?? "./data/claude-web.db";
  mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (!databasePath) _db = db;
  return db;
}

/** Test seam: close and drop the singleton so the next getDb reopens. */
export function resetDbForTest(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* already closed */
    }
  }
  _db = null;
}
