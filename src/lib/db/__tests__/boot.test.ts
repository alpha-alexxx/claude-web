import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBootDb, resetBootDbForTest } from "../boot";
import { resetDbForTest } from "../client";
import { countUsers } from "../users-repo";
import { resetEnvForTest } from "@/lib/env";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cw-boot-"));
  // getBootDb() validates the full env (fail-fast boot contract), so the
  // Clerk keys must parse. Values are irrelevant dummies — the DB path is
  // what this suite exercises, and no Clerk call happens here.
  process.env.CLERK_SECRET_KEY = "sk_test_dummy";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
  process.env.DATABASE_PATH = path.join(dir, "app.db");
  resetEnvForTest();
  resetDbForTest();
  resetBootDbForTest();
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.DATABASE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("boot", () => {
  it("returns a migrated database and caches it across calls", () => {
    const first = getBootDb();
    // Migration ran: the users table exists, even though nothing wrote to it.
    expect(countUsers(first)).toBe(0);
    // Singleton: a second call returns the same connection, not a new one.
    const second = getBootDb();
    expect(second).toBe(first);
    expect(existsSync(process.env.DATABASE_PATH!)).toBe(true);
  });

  it("after reset, reopens a fresh migrated connection", () => {
    const first = getBootDb();
    resetBootDbForTest();
    const second = getBootDb();
    expect(second).not.toBe(first);
    // The new connection is migrated too, not a bare file.
    expect(countUsers(second)).toBe(0);
  });

  it("creates the data directory private and the database file owner-only", () => {
    // The data directory holds the SQLite database (transcripts, audit rows),
    // integrations.env and render.key. SECURITY.md states 0700/0600, and a
    // world-readable transcript is a leak the app would otherwise never
    // report — so the mode is pinned here, after boot has created both.
    // A nested path, so the directory under test is one this app created
    // rather than mkdtemp's own (already private) temp dir.
    const dataDir = path.join(dir, "data");
    process.env.DATABASE_PATH = path.join(dataDir, "app.db");
    // getEnv() caches the parse, so the path change needs a reset too.
    resetEnvForTest();
    resetBootDbForTest();

    getBootDb();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(process.env.DATABASE_PATH).mode & 0o777).toBe(0o600);
  });

  it("also locks the WAL sidecars down to 0600 on the next boot", () => {
    // WAL mode is on, so recent pages live in `-wal` until a checkpoint: an
    // owner-only database with a world-readable `-wal` leaks what was just
    // written. The sidecar appears on the first write, so this test writes a
    // row and re-boots to prove the chmod covers it.
    const dataDir = path.join(dir, "wal");
    process.env.DATABASE_PATH = path.join(dataDir, "app.db");
    resetEnvForTest();
    resetBootDbForTest();

    const db = getBootDb();
    db.exec("CREATE TABLE probe (v TEXT)");
    db.exec("INSERT INTO probe VALUES ('written-into-the-wal')");

    resetBootDbForTest();
    getBootDb();

    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${process.env.DATABASE_PATH}${suffix}`;
      if (!existsSync(sidecar)) continue; // checkpointed away is fine
      expect(statSync(sidecar).mode & 0o777).toBe(0o600);
    }
  });
});
