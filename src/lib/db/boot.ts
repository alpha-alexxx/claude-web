import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./client";
import { migrate } from "./migrate";
import { getEnv } from "../env";

/**
 * Boot-time database singleton: opens (and creates) the configured SQLite
 * file with migrations applied, once per server process.
 *
 * The plan's startup preflight is "fail fast, never half-configured" — a
 * missing table on the first authenticated request would be a runtime 500
 * far from the cause, so the schema is guaranteed before any request is
 * served. getDb() is deliberately not migrated (callers may want a raw
 * connection in tests); this module is the one production entry point.
 */
let _bootDb: ReturnType<typeof getDb> | null = null;

/**
 * Pin the data directory to owner-only, and the database file too.
 *
 * SECURITY.md promises 0700/0600, and the data directory holds every
 * conversation transcript, the audit log, `integrations.env` and
 * `render.key`. `mkdirSync({ mode })` is subject to the process umask and is
 * ignored for a directory that already exists, and SQLite creates its own
 * file with the umask too — so the modes are set explicitly after creation.
 *
 * Failures are surfaced rather than swallowed: a data directory the server
 * cannot secure is a configuration problem the operator has to see. (A
 * filesystem that does not support modes — a mounted volume — is the one
 * case where the file is still usable but the promise is unmet, and the
 * warning names it.)
 */
function secureDataDir(databasePath: string): void {
  const dir = path.dirname(path.resolve(databasePath));
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    console.warn(
      `[db] could not set ${dir} to mode 0700:`,
      error instanceof Error ? error.message : error,
    );
  }
  try {
    fs.chmodSync(path.resolve(databasePath), 0o600);
  } catch {
    // The file may not exist yet on the very first open; SQLite creates it on
    // the first write, so the chmod is retried on the next boot.
  }
  // WAL mode keeps two sidecars alive next to the database, and they hold
  // recently written pages — a transcript written a second ago can be in the
  // `-wal` before any checkpoint. Securing the database and leaving them
  // world-readable would be a mode promise kept on paper only.
  for (const suffix of ["-wal", "-shm"]) {
    try {
      fs.chmodSync(`${path.resolve(databasePath)}${suffix}`, 0o600);
    } catch {
      // Absent until the first write, or already checkpointed away.
    }
  }
}

export function getBootDb(): ReturnType<typeof getDb> {
  if (!_bootDb) {
    const databasePath = getEnv().DATABASE_PATH;
    const db = getDb(databasePath);
    migrate(db);
    secureDataDir(databasePath);
    _bootDb = db;
  }
  return _bootDb;
}

/** Test seam: drop the boot singleton so the next getBootDb() re-runs migrate. */
export function resetBootDbForTest(): void {
  _bootDb = null;
}
