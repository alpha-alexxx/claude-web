import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import * as registry from "@/lib/providers/registry";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * Stop endpoint: peek the live pool session for this user+conversation and
 * interrupt it. Never spawns a session — an unopened conversation is a no-op
 * 404, not a new CLI process.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

const interrupt = vi.fn(async () => {});
const liveSession = vi.fn();

vi.mock("@/lib/providers/registry", () => ({
  getAdapter: vi.fn(() => ({
    id: "claude",
    capabilities: {},
    inventory: async () => ({}),
    startsSession: vi.fn(),
    liveSession,
  })),
  listAdapters: () => [],
  listProviderSummaries: () => [],
}));

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const flush = () => new Promise((r) => setTimeout(r, 0));

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
  useDummyEnv();
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  liveSession.mockReset();
  interrupt.mockClear();
  void registry;
});

afterEach(clearDummyEnv);

describe("POST /api/chat/[id]/stop", () => {
  it("interrupts the live session keyed by user:conversation", async () => {
    liveSession.mockReturnValueOnce({ interrupt });
    const res = await stop("conv-9");
    expect(res.status).toBe(200);
    expect(liveSession).toHaveBeenCalledWith("user_1:conv-9");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("404 when no live session exists (never spawns one)", async () => {
    liveSession.mockReturnValueOnce(null);
    const res = await stop();
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
    liveSession.mockReturnValueOnce({
      interrupt: vi.fn(async () => {
        await flush();
        throw new Error("already finished");
      }),
    });
    const res = await stop();
    expect(res.status).toBe(200);
  });
});
