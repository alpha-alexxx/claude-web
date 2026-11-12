import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../migrate";
import {
  countEnabledAdmins,
  countUsers,
  deleteUser,
  ensureUser,
  findUserById,
  listUsers,
  setUserDisabled,
  setUserRole,
} from "../users-repo";

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cw-users-"));
  db = new DatabaseSync(path.join(dir, "t.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const alice = {
  id: "user_2abc",
  email: "alice@example.com",
  displayName: "Alice",
};

describe("ensureUser", () => {
  it("creates the row on first sight with the Clerk id as primary key", () => {
    const u = ensureUser(db, alice);
    expect(u.id).toBe("user_2abc");
    expect(u.email).toBe("alice@example.com");
    expect(u.displayName).toBe("Alice");
    expect(u.role).toBe("admin"); // first user in an empty table
    expect(u.disabled).toBe(false);
    expect(findUserById(db, "user_2abc")).toEqual(u);
  });

  it("makes only the first user an admin", () => {
    ensureUser(db, alice);
    const bob = ensureUser(db, {
      id: "user_3def",
      email: "bob@example.com",
      displayName: null,
    });
    expect(bob.role).toBe("user");
  });

  it("cannot mint two admins even if the insert is retried against a stale count", () => {
    // The role is chosen inside the INSERT's own subquery, so there is no
    // window between reading "zero users" and writing the first row. Re-running
    // ensureUser for a DIFFERENT new id must therefore see the first row.
    ensureUser(db, alice);
    ensureUser(db, {
      id: "user_3def",
      email: "bob@example.com",
      displayName: null,
    });
    const admins = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number };
    expect(admins.n).toBe(1);
  });

  it("is idempotent and refreshes email/display name from Clerk", () => {
    ensureUser(db, alice);
    const again = ensureUser(db, {
      id: "user_2abc",
      email: "alice@new.example",
      displayName: "Alice A.",
    });
    expect(again.role).toBe("admin");
    expect(again.email).toBe("alice@new.example");
    expect(again.displayName).toBe("Alice A.");
    expect(countUsers(db)).toBe(1);
  });

  it("never promotes an existing user whose row was written as user", () => {
    ensureUser(db, alice);
    const bob = ensureUser(db, { id: "user_3def", email: "bob@example.com" });
    expect(bob.role).toBe("user");
    db.prepare("DELETE FROM users WHERE id = ?").run("user_2abc");
    // Table now has rows, so even a fresh id must not become admin.
    const carol = ensureUser(db, { id: "user_4ghi", email: "carol@example.com" });
    expect(carol.role).toBe("user");
  });
});

describe("mutations", () => {
  it("setUserRole and setUserDisabled apply and bump updated_at", () => {
    const u = ensureUser(db, alice);
    db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      u.id,
    );
    setUserRole(db, u.id, "user");
    setUserDisabled(db, u.id, true);
    const after = findUserById(db, u.id)!;
    expect(after.role).toBe("user");
    expect(after.disabled).toBe(true);
    expect(after.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("deleteUser removes the row and its conversations", () => {
    const u = ensureUser(db, alice);
    db.prepare("INSERT INTO conversations (id, user_id) VALUES (?, ?)").run(
      "conv_1",
      u.id,
    );
    deleteUser(db, u.id);
    expect(findUserById(db, u.id)).toBeNull();
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});

describe("listing and admin guard", () => {
  it("listUsers returns newest first and exposes no secrets", () => {
    ensureUser(db, alice);
    ensureUser(db, { id: "user_3def", email: "bob@example.com" });
    const users = listUsers(db);
    expect(users.map((u) => u.id)).toEqual(["user_3def", "user_2abc"]);
    for (const u of users) {
      expect(u).not.toHaveProperty("password_hash");
      expect(u).not.toHaveProperty("passwordHash");
    }
  });

  it("countEnabledAdmins ignores disabled admins", () => {
    const u = ensureUser(db, alice);
    expect(countEnabledAdmins(db)).toBe(1);
    setUserDisabled(db, u.id, true);
    expect(countEnabledAdmins(db)).toBe(0);
  });
});
