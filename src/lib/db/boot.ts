import "server-only";
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

export function getBootDb(): ReturnType<typeof getDb> {
  if (!_bootDb) {
    const db = getDb(getEnv().DATABASE_PATH);
    migrate(db);
    _bootDb = db;
  }
  return _bootDb;
}

/** Test seam: drop the boot singleton so the next getBootDb() re-runs migrate. */
export function resetBootDbForTest(): void {
  _bootDb = null;
}
