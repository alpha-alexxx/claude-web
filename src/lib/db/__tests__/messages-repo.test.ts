import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrate } from "../migrate";
import { ensureConversation } from "../conversations-repo";
import { appendMessage, listMessages } from "../messages-repo";

/**
 * Transcript rows: the durable half of a conversation. The session pool is
 * ephemeral (LRU, process lifetime); these rows are what a reopened
 * conversation is rebuilt from.
 *
 * Ordering is `created_at, rowid` — two messages can land inside the same
 * millisecond, and a transcript that shuffles user/assistant order on reload
 * is worse than one that is missing a row.
 */

let dir: string;
let db: DatabaseSync;
const CONV = "user_1:c1";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "msgs-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id, email, role) VALUES ('user_1', 'a@b.c', 'user')").run();
  ensureConversation(db, {
    id: CONV,
    userId: "user_1",
    provider: "claude",
    cwd: "/w",
    model: null,
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("appendMessage / listMessages", () => {
  it("round-trips content and returns rows in insertion order", () => {
    const a = appendMessage(db, {
      conversationId: CONV,
      role: "user",
      content: { text: "hi" },
    });
    const b = appendMessage(db, {
      conversationId: CONV,
      role: "assistant",
      content: { blocks: [], end: { reason: "done" } },
    });
    const rows = listMessages(db, CONV);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toEqual({ text: "hi" });
    expect(rows[1].content).toEqual({ blocks: [], end: { reason: "done" } });
  });

  it("gives each message a distinct id", () => {
    const a = appendMessage(db, { conversationId: CONV, role: "user", content: {} });
    const b = appendMessage(db, { conversationId: CONV, role: "user", content: {} });
    expect(a).not.toBe(b);
  });

  it("scopes the list to one conversation", () => {
    ensureConversation(db, {
      id: "user_1:c2",
      userId: "user_1",
      provider: "claude",
      cwd: "/w",
      model: null,
    });
    appendMessage(db, { conversationId: CONV, role: "user", content: {} });
    appendMessage(db, { conversationId: "user_1:c2", role: "user", content: {} });
    expect(listMessages(db, CONV)).toHaveLength(1);
  });

  it("touches the conversation's updated_at", () => {
    db.prepare(
      "UPDATE conversations SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(CONV);
    appendMessage(db, { conversationId: CONV, role: "user", content: {} });
    const row = db
      .prepare("SELECT updated_at FROM conversations WHERE id = ?")
      .get(CONV) as { updated_at: string };
    expect(row.updated_at > "2020-01-01T00:00:00.000Z").toBe(true);
  });

  it("rejects a message for a conversation that does not exist (FK on)", () => {
    expect(() =>
      appendMessage(db, { conversationId: "user_1:ghost", role: "user", content: {} }),
    ).toThrow();
  });

  it("skips a row whose content_json is corrupt instead of throwing", () => {
    // A torn write after a crash, or a manual edit, leaves invalid JSON in a
    // column nothing constrains. One such row must not make the whole
    // conversation unopenable: transcript.ts already promises replay is total,
    // and it cannot keep that promise if the throw happens a layer below it.
    const good = appendMessage(db, { conversationId: CONV, role: "user", content: { text: "hi" } });
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content_json) VALUES (?, ?, ?, ?)",
    ).run("broken", CONV, "assistant", "{not json");
    const rows = listMessages(db, CONV);
    expect(rows.map((r) => r.id)).toEqual([good]);
  });

  it("keeps the NEWEST messages when the window truncates", () => {
    // Oldest-first with an ascending LIMIT silently drops the tail of a long
    // conversation — the part the user just asked for and is scrolling to.
    const ids = Array.from({ length: 5 }, (_, i) =>
      appendMessage(db, { conversationId: CONV, role: "user", content: { text: `m${i}` } }),
    );
    const rows = listMessages(db, CONV, 2);
    expect(rows.map((r) => r.id)).toEqual([ids[3], ids[4]]);
  });
});
