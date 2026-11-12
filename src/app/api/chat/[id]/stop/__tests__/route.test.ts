import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { ensureConversation } from "@/lib/db/conversations-repo";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * Stop endpoint: peek the live pool session for this user+conversation and
 * interrupt it. Never spawns a session — an unopened conversation is a no-op
 * 404, not a new CLI process.
 *
 * The provider is resolved from the caller's own conversation row, so the
 * cases below also pin the ownership and provider-selection contract: a
 * foreign row is indistinguishable from a missing one, and a non-Claude row
 * asks its OWN adapter for the live session.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

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

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const flush = () => new Promise((r) => setTimeout(r, 0));

let tmpDir: string;

function seed(userId: string, clientId: string, provider = "claude") {
  ensureConversation(getBootDb(), {
    id: `${userId}:${clientId}`,
    userId,
    provider,
    cwd: "/tmp",
    model: null,
  });
}

async function stop(
  id = "c1",
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = {
    headers: new Headers({ host: "x", origin: "http://x", ...headers }),
  };
  const ctx = { params: Promise.resolve({ id }) };
  return POST(
    req as unknown as Parameters<typeof POST>[0],
    ctx as unknown as Parameters<typeof POST>[1],
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-api-"));
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
  claudeLiveSession.mockReset();
  codexLiveSession.mockReset();
  interrupt.mockClear();
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/chat/[id]/stop", () => {
  it("interrupts the live session for the caller's own conversation", async () => {
    seed("user_1", "conv-9");
    claudeLiveSession.mockReturnValueOnce({ interrupt });
    const res = await stop("conv-9");
    expect(res.status).toBe(200);
    expect(claudeLiveSession).toHaveBeenCalledWith("user_1:conv-9");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("asks the row's own provider for the live session", async () => {
    seed("user_1", "conv-9", "codex");
    codexLiveSession.mockReturnValueOnce({ interrupt });
    const res = await stop("conv-9");
    expect(res.status).toBe(200);
    expect(codexLiveSession).toHaveBeenCalledWith("user_1:conv-9");
    expect(claudeLiveSession).not.toHaveBeenCalled();
  });

  it("404 when no live session exists (never spawns one)", async () => {
    seed("user_1", "c1");
    claudeLiveSession.mockReturnValueOnce(null);
    const res = await stop();
    expect(res.status).toBe(404);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("404 for a conversation that was never created", async () => {
    const res = await stop("ghost");
    expect(res.status).toBe(404);
    expect(claudeLiveSession).not.toHaveBeenCalled();
  });

  it("404 for another user's conversation, with no adapter peek at all", async () => {
    seed("user_2", "theirs");
    claudeLiveSession.mockReturnValueOnce({ interrupt });
    const res = await stop("theirs");
    expect(res.status).toBe(404);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("401 without an actor", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await stop();
    expect(res.status).toBe(401);
  });

  it("403 on a cross-origin request", async () => {
    const res = await stop("c1", { origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("200 and no throw when interrupt itself fails", async () => {
    seed("user_1", "c1");
    claudeLiveSession.mockReturnValueOnce({
      interrupt: vi.fn(async () => {
        await flush();
        throw new Error("already finished");
      }),
    });
    const res = await stop();
    expect(res.status).toBe(200);
  });
});
