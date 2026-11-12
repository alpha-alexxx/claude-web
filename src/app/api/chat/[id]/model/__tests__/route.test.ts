import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { getAdapter } from "@/lib/providers/registry";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { ensureConversation } from "@/lib/db/conversations-repo";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * Mid-session model switch. The picker calls this when a session is already
 * live; it must never spawn one (a fresh session gets its model on the next
 * turn's POST /api/chat, where spawn options are still meaningful).
 *
 * The provider is resolved from the caller's own conversation row: the body
 * may only confirm it, never choose it, and a foreign row is the same 404 as
 * a missing one.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/providers/registry", () => ({ getAdapter: vi.fn() }));

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const live = {
  send: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  setModel: vi.fn(async () => {}),
  onEvent: vi.fn(),
  offEvent: vi.fn(),
  close: vi.fn(async () => {}),
};

const adapter = {
  id: "claude",
  capabilities: {},
  inventory: vi.fn(),
  startsSession: vi.fn(),
  liveSession: vi.fn((key: string) => (key === "user_1:c1" ? live : null)),
};

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

function post(
  id: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const text = JSON.stringify(body);
  const req = {
    headers: new Headers({
      host: "x",
      origin: "http://x",
      "content-length": String(Buffer.byteLength(text)),
      ...headers,
    }),
    json: async () => JSON.parse(text),
  };
  return POST(req as unknown as Parameters<typeof POST>[0], {
    params: Promise.resolve({ id }),
  } as Parameters<typeof POST>[1]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-api-"));
  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_1", "user_1@example.test");
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_2", "user_2@example.test");

  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  vi.mocked(getAdapter).mockReturnValue(adapter as never);
  live.setModel.mockClear();
  adapter.liveSession.mockClear();
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/chat/[id]/model", () => {
  it("401 unauthenticated", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await post("c1", { model: "opus" });
    expect(res.status).toBe(401);
  });

  it("403 cross-origin", async () => {
    const res = await post("c1", { model: "opus" }, { origin: "http://evil" });
    expect(res.status).toBe(403);
  });

  it("400 invalid body", async () => {
    const res = await post("c1", { model: 42 });
    expect(res.status).toBe(400);
  });

  it("404 when no live session exists (never spawns one)", async () => {
    seed("user_1", "other");
    const res = await post("other", { model: "opus" });
    expect(res.status).toBe(404);
    expect(live.setModel).not.toHaveBeenCalled();
  });

  it("404 for a conversation that was never created", async () => {
    const res = await post("ghost", { model: "opus" });
    expect(res.status).toBe(404);
    expect(adapter.liveSession).not.toHaveBeenCalled();
  });

  it("404 for another user's conversation", async () => {
    seed("user_2", "c1");
    const res = await post("c1", { model: "opus" });
    expect(res.status).toBe(404);
    expect(live.setModel).not.toHaveBeenCalled();
  });

  it("applies the model to the live user-scoped session", async () => {
    seed("user_1", "c1");
    const res = await post("c1", { model: "sonnet" });
    expect(res.status).toBe(200);
    expect(adapter.liveSession).toHaveBeenCalledWith("user_1:c1");
    expect(live.setModel).toHaveBeenCalledWith("sonnet");
    expect(adapter.startsSession).not.toHaveBeenCalled();
  });

  it("409 when the body names a provider the conversation does not use", async () => {
    seed("user_1", "c1");
    const res = await post("c1", { model: "opus", provider: "codex" });
    expect(res.status).toBe(409);
    expect(live.setModel).not.toHaveBeenCalled();
  });

  it("maps 'auto' to an undefined override (CLI default)", async () => {
    seed("user_1", "c1");
    const res = await post("c1", { model: "auto" });
    expect(res.status).toBe(200);
    expect(live.setModel).toHaveBeenCalledWith(undefined);
  });

  it("200 even when setModel rejects (turn in flight) — best effort", async () => {
    seed("user_1", "c1");
    live.setModel.mockRejectedValueOnce(new Error("turn running"));
    const res = await post("c1", { model: "opus" });
    expect(res.status).toBe(200);
  });
});
