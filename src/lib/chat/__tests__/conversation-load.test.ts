import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { appendMessage } from "@/lib/db/messages-repo";
import { ensureConversation } from "@/lib/db/conversations-repo";
import { loadConversation } from "../conversation-load";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * loadConversation: the server half of /chat/[id].
 *
 * It shares the API route's ownership rule (row key derives from the caller's
 * id, so a foreign client id simply resolves nothing) and its replay rule
 * (history is a finished view). Both are pinned here because the page must
 * 404 exactly where the API would, or a conversation could be readable in the
 * browser at a URL the API refuses.
 */

let tmpDir: string;

function seed(userId: string, clientId: string, content?: Record<string, unknown>) {
  const db = getBootDb();
  const id = `${userId}:${clientId}`;
  ensureConversation(db, {
    id,
    userId,
    provider: "claude",
    cwd: "/tmp",
    model: null,
    title: clientId,
  });
  if (content) {
    appendMessage(db, { conversationId: id, role: "user", content });
  }
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-load-"));
  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  // conversations.user_id has an FK to the local users mirror — seed the
  // accounts the tests act as (the Clerk-facing row is created on first auth).
  for (const id of ["user_1", "user_2"]) {
    getBootDb()
      .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
      .run(id, `${id}@example.test`);
  }
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConversation", () => {
  it("loads the caller's conversation with its replayed view", () => {
    seed("user_1", "a", { text: "hello" });
    const loaded = loadConversation(getBootDb(), "user_1", "a");
    expect(loaded?.summary).toMatchObject({
      id: "a",
      title: "a",
      provider: "claude",
    });
    expect(loaded?.view.turns).toEqual([{ kind: "user", text: "hello" }]);
    expect(loaded?.view.running).toBe(false);
  });

  it("returns null for another user's client id", () => {
    seed("user_2", "theirs", { text: "secret" });
    expect(loadConversation(getBootDb(), "user_1", "theirs")).toBeNull();
  });

  it("returns null for a client id that was never written", () => {
    expect(loadConversation(getBootDb(), "user_1", "nope")).toBeNull();
  });

  it("loads a row whose transcript is still empty", () => {
    seed("user_1", "empty");
    const loaded = loadConversation(getBootDb(), "user_1", "empty");
    expect(loaded?.view.turns).toEqual([]);
  });

  it("never throws on a malformed stored row", () => {
    seed("user_1", "bad", { text: 42 });
    expect(loadConversation(getBootDb(), "user_1", "bad")?.view.turns).toEqual([]);
  });
});
