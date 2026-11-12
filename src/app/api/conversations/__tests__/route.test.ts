import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { appendMessage } from "@/lib/db/messages-repo";
import { ensureConversation } from "@/lib/db/conversations-repo";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * Conversations API — the sidebar's read/write surface.
 *
 * Every case here is an OWNERSHIP case: the endpoint takes a client-visible
 * conversation id, scopes it to the signed-in user in SQL, and must behave
 * identically for "does not exist" and "belongs to someone else" so ids
 * cannot be probed. The replay case matters too — history must come back
 * inert (no answerable permission cards) and never throw on a bad row.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

// DELETE ends a live turn, so the route resolves the conversation's OWN
// adapter from its row. Mock the registry rather than the real adapter: no CLI
// process exists in a test, and the assertion is "the row's provider was
// asked, then interrupted", not how the SDK behaves.
const interrupt = vi.fn(async () => {});
const claudeLiveSession = vi.fn();
const codexLiveSession = vi.fn();
const adapterFor = vi.fn((id: string) =>
  id === "claude"
    ? {
        id: "claude",
        capabilities: {},
        inventory: async () => ({}),
        startsSession: vi.fn(),
        liveSession: claudeLiveSession,
      }
    : id === "codex"
      ? {
          id: "codex",
          capabilities: {},
          inventory: async () => ({}),
          startsSession: vi.fn(),
          liveSession: codexLiveSession,
        }
      : null,
);

vi.mock("@/lib/providers/registry", () => ({
  getAdapter: (id: string) => adapterFor(id),
  listAdapters: () => [],
  listProviderSummaries: () => [],
}));

// Imported after the mock so the routes pick it up.
import { GET as list } from "../route";
import {
  GET as getOne,
  PATCH as patchOne,
  DELETE as deleteOne,
} from "../[id]/route";

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const OTHER_USER_ROW = {
  id: "user_2:theirs",
  userId: "user_2",
  provider: "claude",
  cwd: "/tmp",
};

let tmpDir: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(method: string, body?: unknown): Request {
  return {
    method,
    headers: new Headers({ host: "x", origin: "http://x" }),
    json: async () => body,
  } as unknown as Request;
}

function seed(userId: string, clientId: string, text: string, title?: string) {
  const db = getBootDb();
  const id = `${userId}:${clientId}`;
  ensureConversation(db, {
    id,
    userId,
    provider: "claude",
    cwd: "/tmp",
    model: null,
    title: title ?? null,
  });
  appendMessage(db, { conversationId: id, role: "user", content: { text } });
  return id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-api-"));
  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_1", "user_1@example.test");
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_2", "user_2@example.test");
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  interrupt.mockClear();
  claudeLiveSession.mockReset();
  codexLiveSession.mockReset();
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/conversations", () => {
  it("lists only the caller's conversations, newest first", async () => {
    seed("user_1", "a", "first");
    seed("user_1", "b", "second");
    seed("user_2", "theirs", "not yours");
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    expect(body.conversations.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("hides conversations that were never used", async () => {
    seed("user_1", "used", "hi");
    ensureConversation(getBootDb(), {
      id: "user_1:empty",
      userId: "user_1",
      provider: "claude",
      cwd: "/tmp",
      model: null,
    });
    const body = (await (await list()).json()) as {
      conversations: Array<{ id: string }>;
    };
    expect(body.conversations.map((c) => c.id)).toEqual(["used"]);
  });

  it("401 without an actor", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    expect((await list()).status).toBe(401);
  });
});

describe("GET /api/conversations/[id]", () => {
  it("replays the transcript as a read-only view", async () => {
    seed("user_1", "a", "hello", "hello");
    const res = await getOne(req("GET"), ctx("a") as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { id: string; title: string; provider: string };
      view: { turns: Array<{ kind: string; text?: string }>; running: boolean };
    };
    expect(body.conversation).toMatchObject({ id: "a", title: "hello" });
    expect(body.view.turns).toEqual([{ kind: "user", text: "hello" }]);
    expect(body.view.running).toBe(false);
  });

  it("404s another user's conversation, exactly like a missing one", async () => {
    seed("user_2", "theirs", "secret");
    const theirs = await getOne(req("GET"), ctx("theirs") as never);
    const missing = await getOne(req("GET"), ctx("nope") as never);
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.text()).toBe(await missing.text());
  });
});

describe("PATCH /api/conversations/[id]", () => {
  it("renames the caller's conversation", async () => {
    seed("user_1", "a", "hi", "hi");
    const res = await patchOne(req("PATCH", { title: "  New name  " }), ctx("a") as never);
    expect(res.status).toBe(200);
    const row = getBootDb()
      .prepare("SELECT title FROM conversations WHERE id = ?")
      .get("user_1:a") as { title: string };
    expect(row.title).toBe("New name");
  });

  it("rejects an empty or oversized title", async () => {
    seed("user_1", "a", "hi");
    expect((await patchOne(req("PATCH", { title: "   " }), ctx("a") as never)).status).toBe(400);
    expect(
      (await patchOne(req("PATCH", { title: "x".repeat(201) }), ctx("a") as never)).status,
    ).toBe(400);
  });

  it("403s on a cross-origin request", async () => {
    seed("user_1", "a", "hi");
    const cross = await patchOne(
      {
        method: "PATCH",
        headers: new Headers({ host: "x", origin: "http://evil.example" }),
        json: async () => ({ title: "x" }),
      } as unknown as Request,
      ctx("a") as never,
    );
    expect(cross.status).toBe(403);
  });

  it("404s another user's conversation and leaves its title alone", async () => {
    seed("user_2", "theirs", "secret", "theirs");
    const res = await patchOne(req("PATCH", { title: "hacked" }), ctx("theirs") as never);
    expect(res.status).toBe(404);
    const row = getBootDb()
      .prepare("SELECT title FROM conversations WHERE id = ?")
      .get(OTHER_USER_ROW.id) as { title: string };
    expect(row.title).toBe("theirs");
  });
});

describe("DELETE /api/conversations/[id]", () => {
  it("deletes the conversation and its messages", async () => {
    seed("user_1", "a", "hi");
    const res = await deleteOne(req("DELETE"), ctx("a") as never);
    expect(res.status).toBe(200);
    const count = getBootDb()
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .get("user_1:a") as { n: number };
    expect(Number(count.n)).toBe(0);
  });

  it("404s another user's conversation and deletes nothing", async () => {
    seed("user_2", "theirs", "secret");
    const res = await deleteOne(req("DELETE"), ctx("theirs") as never);
    expect(res.status).toBe(404);
    const row = getBootDb()
      .prepare("SELECT id FROM conversations WHERE id = ?")
      .get(OTHER_USER_ROW.id);
    expect(row).toBeDefined();
  });

  it("403s on a cross-origin request", async () => {
    seed("user_1", "a", "hi");
    const res = await deleteOne(
      {
        method: "DELETE",
        headers: new Headers({ host: "x", origin: "http://evil.example" }),
      } as unknown as Request,
      ctx("a") as never,
    );
    expect(res.status).toBe(403);
  });

  it("interrupts the live session before deleting the row", async () => {
    // Deleting a row while its agent keeps running spends money with nowhere
    // to record the result, and the recorder's later writes fail the FK. The
    // turn has to end with the conversation.
    seed("user_1", "a", "hi");
    claudeLiveSession.mockReturnValueOnce({ interrupt });
    const res = await deleteOne(req("DELETE"), ctx("a") as never);
    expect(res.status).toBe(200);
    expect(claudeLiveSession).toHaveBeenCalledWith("user_1:a");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("asks the row's own adapter, not always Claude", async () => {
    seed("user_1", "b", "hi");
    getBootDb().prepare("UPDATE conversations SET provider = 'codex' WHERE id = ?").run("user_1:b");
    codexLiveSession.mockReturnValueOnce({ interrupt });
    await deleteOne(req("DELETE"), ctx("b") as never);
    expect(codexLiveSession).toHaveBeenCalledWith("user_1:b");
    expect(claudeLiveSession).not.toHaveBeenCalled();
  });

  it("still deletes when there is no live session", async () => {
    seed("user_1", "a", "hi");
    claudeLiveSession.mockReturnValueOnce(null);
    const res = await deleteOne(req("DELETE"), ctx("a") as never);
    expect(res.status).toBe(200);
    expect(
      getBootDb().prepare("SELECT id FROM conversations WHERE id = ?").get("user_1:a"),
    ).toBeUndefined();
  });

  it("deletes even when the interrupt rejects", async () => {
    // A CLI that died mid-interrupt must not turn "delete" into a 500.
    seed("user_1", "a", "hi");
    claudeLiveSession.mockReturnValueOnce({
      interrupt: vi.fn(async () => {
        throw new Error("dead");
      }),
    });
    const res = await deleteOne(req("DELETE"), ctx("a") as never);
    expect(res.status).toBe(200);
  });
});
