import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrate } from "../migrate";
import {
  conversationIdFor,
  ensureConversation,
  findConversation,
} from "../conversations-repo";

/**
 * The conversation row is created by the SERVER, from a server-derived id
 * (`${userId}:${clientConversationId}` — the same string as the session pool
 * key). A client-supplied id must never be able to address another user's
 * row: that is the ownership guard Phase 5 formalizes, and the reason
 * tool_calls' FK can be trusted already.
 */

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "convs-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare(
    "INSERT INTO users (id, email, role) VALUES ('user_1', 'a@b.c', 'user')",
  ).run();
  db.prepare(
    "INSERT INTO users (id, email, role) VALUES ('user_2', 'd@e.f', 'user')",
  ).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("conversationIdFor", () => {
  it("derives a user-scoped id — two users' equal client ids never collide", () => {
    expect(conversationIdFor("user_1", "c1")).toBe("user_1:c1");
    expect(conversationIdFor("user_2", "c1")).toBe("user_2:c1");
  });
});

describe("ensureConversation", () => {
  it("creates the row with the derived id and its owner", () => {
    ensureConversation(db, {
      id: conversationIdFor("user_1", "c1"),
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: "opus",
    });
    const row = findConversation(db, "user_1:c1");
    expect(row).toMatchObject({
      id: "user_1:c1",
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: "opus",
    });
    expect(row?.createdAt).toBeTruthy();
  });

  it("is idempotent: a second turn reuses the same row", () => {
    const seed = {
      id: conversationIdFor("user_1", "c1"),
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: null,
    };
    ensureConversation(db, seed);
    ensureConversation(db, { ...seed, cwd: "/w/sub" });
    const rows = db.prepare("SELECT id, cwd FROM conversations").all();
    expect(rows).toHaveLength(1);
    expect(findConversation(db, "user_1:c1")?.cwd).toBe("/w/sub");
  });

  it("a turn without a model keeps the stored one", () => {
    ensureConversation(db, {
      id: conversationIdFor("user_1", "c1"),
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: "sonnet",
    });
    ensureConversation(db, {
      id: conversationIdFor("user_1", "c1"),
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: null,
    });
    expect(findConversation(db, "user_1:c1")?.model).toBe("sonnet");
  });

  it("never rewrites a row owned by someone else", () => {
    // Only reachable if a row was created outside the derivation rule — the
    // update is owner-guarded anyway, because an audit trail that can be
    // repointed at another user's conversation is worse than no audit.
    db.prepare(
      "INSERT INTO conversations (id, user_id) VALUES ('user_2:c1', 'user_2')",
    ).run();
    ensureConversation(db, {
      id: "user_2:c1",
      userId: "user_1",
      provider: "claude",
      cwd: "/attacker",
      model: null,
    });
    const row = findConversation(db, "user_2:c1");
    expect(row?.userId).toBe("user_2");
    expect(row?.cwd).toBeNull();
  });

  it("rejects a conversation for a user that does not exist (FK on)", () => {
    expect(() =>
      ensureConversation(db, {
        id: conversationIdFor("user_ghost", "c1"),
        userId: "user_ghost",
        provider: "claude",
        cwd: "/w",
        model: null,
      }),
    ).toThrow();
  });
});
