import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import { getAdapter } from "@/lib/providers/registry";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * Mid-session model switch. The picker calls this when a session is already
 * live; it must never spawn one (a fresh session gets its model on the next
 * turn's POST /api/chat, where spawn options are still meaningful).
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
  useDummyEnv();
  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  vi.mocked(getAdapter).mockReturnValue(adapter as never);
  live.setModel.mockClear();
  adapter.liveSession.mockClear();
});

afterEach(clearDummyEnv);

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
    const res = await post("other", { model: "opus" });
    expect(res.status).toBe(404);
    expect(live.setModel).not.toHaveBeenCalled();
  });

  it("applies the model to the live user-scoped session", async () => {
    const res = await post("c1", { model: "sonnet" });
    expect(res.status).toBe(200);
    expect(adapter.liveSession).toHaveBeenCalledWith("user_1:c1");
    expect(live.setModel).toHaveBeenCalledWith("sonnet");
    expect(adapter.startsSession).not.toHaveBeenCalled();
  });

  it("maps 'auto' to an undefined override (CLI default)", async () => {
    const res = await post("c1", { model: "auto" });
    expect(res.status).toBe(200);
    expect(live.setModel).toHaveBeenCalledWith(undefined);
  });

  it("200 even when setModel rejects (turn in flight) — best effort", async () => {
    live.setModel.mockRejectedValueOnce(new Error("turn running"));
    const res = await post("c1", { model: "opus" });
    expect(res.status).toBe(200);
  });
});
