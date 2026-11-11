import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * The permission answer route is a privileged control on a live agent
 * process. It is user-scoped (the broker ignores another user's requestId),
 * origin-checked, rate-limited, and validates its body like every other
 * non-GET route.
 */

const broker = {
  resolve: vi.fn(),
};

vi.mock("@/lib/providers/claude/broker", () => ({
  getPermissionBroker: () => broker,
}));
vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

function post(
  requestId: string,
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
    params: Promise.resolve({ requestId }),
  } as Parameters<typeof POST>[1]);
}

beforeEach(() => {
  useDummyEnv();
  resetRateLimits();
  broker.resolve.mockReset();
  broker.resolve.mockReturnValue({ ok: true, decision: "allow" });
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
});

afterEach(clearDummyEnv);

describe("POST /api/permissions/[requestId]", () => {
  it("401 unauthenticated", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await post("req-1", { decision: "allow" });
    expect(res.status).toBe(401);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it("403 cross-origin", async () => {
    const res = await post("req-1", { decision: "allow" }, { origin: "http://evil" });
    expect(res.status).toBe(403);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it("400 invalid decision value", async () => {
    const res = await post("req-1", { decision: "yes please" });
    expect(res.status).toBe(400);
    expect(broker.resolve).not.toHaveBeenCalled();
  });

  it("400 invalid JSON", async () => {
    const req = {
      headers: new Headers({ host: "x", origin: "http://x" }),
      json: async () => {
        throw new Error("bad json");
      },
    };
    const res = await POST(req as unknown as Parameters<typeof POST>[0], {
      params: Promise.resolve({ requestId: "req-1" }),
    } as Parameters<typeof POST>[1]);
    expect(res.status).toBe(400);
  });

  it("forwards allow with the USER id (broker enforces ownership)", async () => {
    const res = await post("req-1", { decision: "allow" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, decision: "allow" });
    expect(broker.resolve).toHaveBeenCalledWith("user_1", "req-1", "allow");
  });

  it("forwards deny and allow_session", async () => {
    broker.resolve.mockReturnValue({ ok: true, decision: "deny" });
    await post("req-2", { decision: "deny" });
    expect(broker.resolve).toHaveBeenLastCalledWith("user_1", "req-2", "deny");

    broker.resolve.mockReturnValue({ ok: true, decision: "allow" });
    await post("req-3", { decision: "allow_session" });
    expect(broker.resolve).toHaveBeenLastCalledWith(
      "user_1",
      "req-3",
      "allow_session",
    );
  });

  it("404 for an unknown or already-answered request", async () => {
    broker.resolve.mockReturnValue({ ok: false, code: "not_found" });
    const res = await post("req-404", { decision: "allow" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found" });
  });

  it("429 when the answer budget is exhausted", async () => {
    // The answer path shares the turn bucket: clicking is cheap, but the
    // request list is the throttle that keeps a stale tab from brute-forcing
    // ids. Sequential, so "the 11th is the one that trips" is deterministic.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await post(`r${i}`, { decision: "allow" })).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses.at(-1)).toBe(429);
  });
});
