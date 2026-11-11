import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBootDb, resetBootDbForTest } from "../boot";
import { resetDbForTest } from "../client";
import { countUsers } from "../users-repo";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cw-boot-"));
  // getBootDb() validates the full env (fail-fast boot contract), so the
  // Clerk keys must parse. Values are irrelevant dummies — the DB path is
  // what this suite exercises, and no Clerk call happens here.
  process.env.CLERK_SECRET_KEY = "sk_test_dummy";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_dummy";
  process.env.DATABASE_PATH = path.join(dir, "app.db");
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
});
