import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TurnEvent } from "@/lib/providers/types";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import * as registry from "@/lib/providers/registry";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { listToolCalls } from "@/lib/db/tool-calls-repo";
import { findConversation } from "@/lib/db/conversations-repo";
import {
  getPermissionBroker,
  resetPermissionBrokerForTest,
} from "@/lib/providers/claude/broker";
import { resetSessionBindingForTest } from "@/lib/providers/claude/binding";
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
    __test: {
      sent,
      starts,
      adapter,
      emit: (event: TurnEvent) => {
        for (const cb of [...listeners]) cb(event);
      },
    },
  };
});

const fake = vi.mocked(registry) as unknown as {
  __test: {
    sent: string[];
    starts: Record<string, unknown>[];
    adapter: { startsSession: ReturnType<typeof vi.fn> };
    emit: (event: TurnEvent) => void;
  };
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-route-"));
  useDummyEnv({
    ALLOWED_WORKSPACE_ROOTS: CWD,
    DATABASE_PATH: path.join(tmpDir, "app.db"),
  });
  resetDbForTest();
  resetBootDbForTest();
  // The route writes audit rows for a row that must exist: seed the Clerk
  // mirror the way currentActor() would on a real request.
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_1", "user_1@example.test");
  resetPermissionBrokerForTest();
  resetSessionBindingForTest();
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
  resetRateLimits();
  fake.__test.sent.length = 0;
  fake.__test.starts.length = 0;
});

afterEach(() => {
  resetPermissionBrokerForTest();
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type StartsOpts = {
  onPermission?: (req: {
    requestId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<{ behavior: "allow" | "deny"; message?: string } | null>;
  isToolAllowed?: (toolName: string) => boolean;
  onSessionClosed?: () => void;
};

function lastStart(): StartsOpts {
  const opts = fake.__test.starts.at(-1);
  if (!opts) throw new Error("no session was started");
  return opts as unknown as StartsOpts;
}

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

describe("POST /api/chat — permission + audit wiring", () => {
  it("supplies all three session-lifetime hooks to the adapter", async () => {
    await post(goodBody);
    const opts = lastStart();
    expect(typeof opts.onPermission).toBe("function");
    expect(typeof opts.isToolAllowed).toBe("function");
    expect(typeof opts.onSessionClosed).toBe("function");
  });

  it("a permission card is answerable through the broker, scoped to the user", async () => {
    await post(goodBody);
    const opts = lastStart();
    const answer = opts.onPermission?.({
      requestId: "req-route-1",
      toolUseId: "tu-route-1",
      toolName: "Bash",
      input: { command: "ls" },
    });
    // Same API the browser uses — a different user's id resolves nothing.
    expect(getPermissionBroker().resolve("user_2", "req-route-1", "allow")).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(getPermissionBroker().resolve("user_1", "req-route-1", "allow")).toEqual({
      ok: true,
      decision: "allow",
    });
    await expect(answer).resolves.toEqual({ behavior: "allow" });
  });

  it("allow-for-session reaches the pool's pre-check for this conversation", async () => {
    await post(goodBody);
    const opts = lastStart();
    expect(opts.isToolAllowed?.("Bash")).toBe(false);
    const answer = opts.onPermission?.({
      requestId: "req-route-2",
      toolUseId: "tu-route-2",
      toolName: "Bash",
      input: { command: "ls" },
    });
    getPermissionBroker().resolve("user_1", "req-route-2", "allow_session");
    await answer;
    expect(opts.isToolAllowed?.("Bash")).toBe(true);
  });

  it("onSessionClosed forgets the session's allowlist", async () => {
    await post(goodBody);
    const opts = lastStart();
    const answer = opts.onPermission?.({
      requestId: "req-route-3",
      toolUseId: "tu-route-3",
      toolName: "Read",
      input: { file_path: "/tmp/x" },
    });
    getPermissionBroker().resolve("user_1", "req-route-3", "allow_session");
    await answer;
    expect(opts.isToolAllowed?.("Read")).toBe(true);
    opts.onSessionClosed?.();
    expect(opts.isToolAllowed?.("Read")).toBe(false);
  });

  it("creates the conversation row under a server-derived, user-scoped id", async () => {
    await post(goodBody);
    const row = findConversation(getBootDb(), "user_1:c1");
    expect(row).toMatchObject({
      id: "user_1:c1",
      userId: "user_1",
      provider: "claude",
    });
    // The client's raw id is never a row of its own — two users posting "c1"
    // land on two separate rows, neither addressable by the other.
    expect(findConversation(getBootDb(), "c1")).toBeNull();
  });

  it("audits the permission ask, the answer, and the late tool result", async () => {
    await post(goodBody);
    const opts = lastStart();
    const answer = opts.onPermission?.({
      requestId: "req-route-4",
      toolUseId: "tu-route-4",
      toolName: "Bash",
      input: { command: "ls" },
    });

    // Before the answer: the call is already on the audit as pending.
    const before = listToolCalls(getBootDb(), "user_1:c1");
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("pending");

    getPermissionBroker().resolve("user_1", "req-route-4", "allow");
    await answer;
    expect(listToolCalls(getBootDb(), "user_1:c1")[0].status).toBe("allowed");

    // The session-level listener (not the SSE pipe) owns results, so they
    // land even though this turn's stream has already ended.
    fake.__test.emit({ type: "tool_end", id: "tu-route-4", ok: true, output: "a.txt" });
    const [row] = listToolCalls(getBootDb(), "user_1:c1");
    expect(row.status).toBe("ok");
    expect(row.result).toEqual({ ok: true, output: "a.txt" });
  });

  it("audits a denial", async () => {
    await post(goodBody);
    const opts = lastStart();
    const answer = opts.onPermission?.({
      requestId: "req-route-5",
      toolUseId: "tu-route-5",
      toolName: "Write",
      input: { file_path: "/etc/passwd" },
    });
    getPermissionBroker().resolve("user_1", "req-route-5", "deny");
    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
    const [row] = listToolCalls(getBootDb(), "user_1:c1");
    expect(row.status).toBe("denied");
    expect(row.decidedBy).toBe("user_1");
  });

  it("a second turn on the same conversation does not duplicate the audit row", async () => {
    await post(goodBody);
    const first = lastStart();
    const answer = first.onPermission?.({
      requestId: "req-route-6",
      toolUseId: "tu-route-6",
      toolName: "Bash",
      input: { command: "ls" },
    });
    getPermissionBroker().resolve("user_1", "req-route-6", "allow");
    await answer;

    // Reused session: the pool hands back the same object, so the route must
    // not stack a second audit listener on it.
    await post({ ...goodBody, text: "again" });
    fake.__test.emit({ type: "tool_end", id: "tu-route-6", ok: true, output: "a.txt" });
    const rows = listToolCalls(getBootDb(), "user_1:c1");
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toEqual({ ok: true, output: "a.txt" });
  });
});
