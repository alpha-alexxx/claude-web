import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrate } from "../migrate";
import {
  conversationIdFor,
  deleteConversation,
  ensureConversation,
  ensureTitle,
  findConversation,
  listConversations,
  renameConversation,
  setCliSessionId,
} from "../conversations-repo";
import { appendMessage } from "../messages-repo";

/**
 * Phase 5: the conversation row becomes addressable.
 *
 * Every read and write here is OWNER-SCOPED. The list is what a user sees in
 * the sidebar, so a bug that leaks another user's row is a data leak, and the
 * delete/rename paths are the first destructive operations on user data —
 * both must be guarded by `user_id`, not by an id-only match.
 *
 * The list hides conversations with no messages: the client creates a row the
 * moment /chat mounts (so /chat/[id] is a real URL), and a sidebar full of
 * never-used rows is noise.
 */

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "convlist-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id, email, role) VALUES ('user_1', 'a@b.c', 'user')").run();
  db.prepare("INSERT INTO users (id, email, role) VALUES ('user_2', 'd@e.f', 'user')").run();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(
  userId: string,
  clientId: string,
  opts: { title?: string; message?: string } = {},
): string {
  const id = conversationIdFor(userId, clientId);
  ensureConversation(db, {
    id,
    userId,
    provider: "claude",
    cwd: "/w",
    model: null,
    title: opts.title ?? null,
  });
  appendMessage(db, {
    conversationId: id,
    role: "user",
    content: { text: opts.message ?? "hello" },
  });
  return id;
}

describe("listConversations", () => {
  it("returns only the owner's conversations", () => {
    seed("user_1", "c1");
    seed("user_2", "c2");
    const rows = listConversations(db, "user_1");
    expect(rows.map((r) => r.id)).toEqual([conversationIdFor("user_1", "c1")]);
  });

  it("orders by most recently updated first", () => {
    seed("user_1", "old");
    seed("user_1", "new");
    // Distinct timestamps: updated_at has millisecond precision.
    db.prepare(
      "UPDATE conversations SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(conversationIdFor("user_1", "old"));
    db.prepare(
      "UPDATE conversations SET updated_at = '2026-06-01T00:00:00.000Z' WHERE id = ?",
    ).run(conversationIdFor("user_1", "new"));
    expect(listConversations(db, "user_1").map((r) => r.id)).toEqual([
      conversationIdFor("user_1", "new"),
      conversationIdFor("user_1", "old"),
    ]);
  });

  it("hides conversations that never got a message", () => {
    seed("user_1", "with-message");
    ensureConversation(db, {
      id: conversationIdFor("user_1", "empty"),
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: null,
    });
    expect(listConversations(db, "user_1").map((r) => r.id)).toEqual([
      conversationIdFor("user_1", "with-message"),
    ]);
  });

  it("respects the limit", () => {
    seed("user_1", "a");
    seed("user_1", "b");
    seed("user_1", "c");
    expect(listConversations(db, "user_1", 2)).toHaveLength(2);
  });
});

describe("deleteConversation", () => {
  it("deletes the owner's row and cascades its messages", () => {
    const id = seed("user_1", "c1");
    expect(deleteConversation(db, id, "user_1")).toBe(true);
    expect(findConversation(db, id)).toBeNull();
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .get(id) as { n: number };
    expect(left.n).toBe(0);
  });

  it("refuses to delete another user's conversation", () => {
    const id = seed("user_1", "c1");
    expect(deleteConversation(db, id, "user_2")).toBe(false);
    expect(findConversation(db, id)).not.toBeNull();
  });
});

describe("renameConversation", () => {
  it("renames the owner's row", () => {
    const id = seed("user_1", "c1");
    expect(renameConversation(db, id, "user_1", "New title")).toBe(true);
    expect(findConversation(db, id)?.title).toBe("New title");
  });

  it("refuses another user's row", () => {
    const id = seed("user_1", "c1");
    expect(renameConversation(db, id, "user_2", "hijack")).toBe(false);
    expect(findConversation(db, id)?.title).not.toBe("hijack");
  });
});

describe("ensureTitle", () => {
  it("sets a title only when the row has none", () => {
    const id = seed("user_1", "c1");
    ensureTitle(db, id, "first");
    ensureTitle(db, id, "second");
    expect(findConversation(db, id)?.title).toBe("first");
  });

  it("does nothing for a missing row", () => {
    expect(() => ensureTitle(db, "user_1:ghost", "t")).not.toThrow();
  });
});

describe("setCliSessionId", () => {
  it("persists the CLI session id for resume", () => {
    const id = seed("user_1", "c1");
    setCliSessionId(db, id, "cli-abc");
    expect(findConversation(db, id)?.cliSessionId).toBe("cli-abc");
  });

  it("is a no-op on an empty id", () => {
    const id = seed("user_1", "c1");
    setCliSessionId(db, id, "");
    expect(findConversation(db, id)?.cliSessionId).toBeNull();
  });
});
