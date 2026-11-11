import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TurnEvent } from "@/lib/providers/types";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import * as registry from "@/lib/providers/registry";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { POST } from "../route";

/**
 * Route tests for POST /api/chat. The adapter seam is faked at the registry
 * boundary (the one edge the route owns), auth is faked — no Clerk, no DB,
 * no CLI. What is under test is the route's own wiring: auth gate, origin
 * gate, rate limit, zod body, cwd containment, provider gate, and the SSE
 * response contract.
 */

type FakeAdapter = NonNullable<ReturnType<typeof registry.getAdapter>>;

vi.mock("@/lib/auth/current-actor", () => ({
  requireActor: vi.fn(),
}));

vi.mock("@/lib/providers/registry", () => {
  const listeners = new Set<(e: TurnEvent) => void>();
  const sent: string[] = [];
  const starts: Record<string, unknown>[] = [];
  const session = {
    send: async (text: string) => {
      sent.push(text);
      for (const cb of [...listeners]) cb({ type: "text_delta", text });
      for (const cb of [...listeners]) {
        cb({
          type: "turn_end",
          reason: "done",
          model: null,
          durationMs: 1,
          costUsd: 0,
          tokens: { input: null, output: null },
          error: null,
        });
      }
    },
    interrupt: async () => {},
    onEvent: (cb: (e: TurnEvent) => void) => listeners.add(cb),
    offEvent: (cb: (e: TurnEvent) => void) => listeners.delete(cb),
    close: async () => {},
  };
  const adapter = {
    id: "claude",
    capabilities: {
      interactiveToolPrompts: true,
      sessionResume: true,
      partialText: true,
      skills: "native",
      plugins: true,
    },
    inventory: async () => ({}),
    startsSession: vi.fn(async (opts: Record<string, unknown>) => {
      starts.push(opts);
      return session;
    }),
    liveSession: vi.fn(() => null),
  };
  return {
    getAdapter: vi.fn((id: string): FakeAdapter | null =>
      id === "claude" ? (adapter as unknown as FakeAdapter) : null,
    ),
    listAdapters: () => [adapter],
    listProviderSummaries: () => [],
    __test: { sent, starts, adapter },
  };
});

const fake = vi.mocked(registry) as unknown as {
  __test: { sent: string[]; starts: Record<string, unknown>[]; adapter: { startsSession: ReturnType<typeof vi.fn> } };
};

const CWD = "/home/ubuntu/claude-web";
const AUTH_OK = {
  ok: true as const,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

/**
 * Minimal Request stand-in. `new Request()` silently drops forbidden headers
 * (Origin among them), which would make the Origin gate untestable; a plain
 * Headers object keeps guard "none" and delivers what the route reads.
 */
function post(body: unknown, headers?: Record<string, string>): Promise<Response> {
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
  return POST(req as unknown as Parameters<typeof POST>[0]);
}

const goodBody = {
  conversationId: "c1",
  cwd: CWD,
  provider: "claude",
  text: "hello",
};

beforeEach(() => {
  useDummyEnv({ ALLOWED_WORKSPACE_ROOTS: CWD });
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  resetRateLimits();
  fake.__test.sent.length = 0;
  fake.__test.starts.length = 0;
});

afterEach(() => {
  clearDummyEnv();
});

describe("POST /api/chat", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await post(goodBody);
    expect(res.status).toBe(401);
  });

  it("403 when Origin does not match the host (cross-site POST)", async () => {
    const res = await post(goodBody, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("400 on an invalid body (missing text)", async () => {
    const res = await post({ conversationId: "c1", cwd: CWD, provider: "claude" });
    expect(res.status).toBe(400);
  });

  it("400 when cwd is outside ALLOWED_WORKSPACE_ROOTS", async () => {
    const res = await post({ ...goodBody, cwd: "/etc" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("workspace");
  });

  it("400 when the provider is not available", async () => {
    const res = await post({ ...goodBody, provider: "codex" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("codex");
  });

  it("503 when the adapter cannot start a session (pool at capacity)", async () => {
    fake.__test.adapter.startsSession.mockRejectedValueOnce(
      new Error("session pool at capacity: every session is mid-turn"),
    );
    const res = await post(goodBody);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("capacity");
  });

  it("streams a turn end-to-end with SSE headers and a user-scoped session key", async () => {
    const res = await post({ ...goodBody, model: "opus" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const frames = (await res.text()).split("\n\n").filter(Boolean);
    expect(frames.some((f) => f.includes('data: {"type":"text_delta","text":"hello"'))).toBe(true);
    expect(frames.some((f) => f.includes('"type":"turn_end"'))).toBe(true);
    expect(fake.__test.sent).toEqual(["hello"]);
    expect(fake.__test.starts.length).toBe(1);
    const opts = fake.__test.starts[0];
    expect(opts.conversationId).toBe("user_1:c1"); // user-scoped pool key
    expect(opts.cwd).toBe(CWD);
    expect(opts.model).toBe("opus");
  });

  it("429 with Retry-After once the per-user turn budget is spent", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await post({ ...goodBody, conversationId: `c-${i}` });
      expect(res.status).toBe(200);
    }
    const res = await post({ ...goodBody, conversationId: "c-11" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
