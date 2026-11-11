import { describe, it, expect, vi, afterEach } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSessionPool,
  type PoolSession,
  type QueryFactory,
} from "../claude/session-pool";
import type { TurnEvent } from "../types";

/**
 * Fake query() factory: the pool creates one `query({ prompt, options })` per
 * conversation. The mirror loop consumes the pool's prompt channel and
 * scripts what the CLI would emit per turn; the async iterator yields those
 * frames to the pool's pump. No real CLI is spawned (ledger ruling: unit
 * tests never pay the ~2 min startup; E2E stubs the provider too).
 *
 * Real-CLI behaviors mirrored here:
 * - `interrupt()` is answered by a belated error-during-execution result frame
 *   (the pool must swallow it — its own synthetic turn_end owns the turn).
 * - The query's iterator ENDS when the CLI process dies (pool must emit an
 *   error turn_end so the UI never hangs) — see `behavior.endsAfter`.
 */

interface FakeCall {
  opts: Record<string, unknown>;
  texts: string[];
}

function makeFactory(
  script: Record<number, unknown[]>,
  behavior: { endsAfter?: number } = {},
): {
  factory: QueryFactory;
  calls: FakeCall[];
  closed: { count: number };
  setModelCalls: (string | undefined)[];
} {
  const calls: FakeCall[] = [];
  const closed = { count: 0 };
  const setModelCalls: (string | undefined)[] = [];

  const factory: QueryFactory = (params) => {
    const call: FakeCall = {
      opts: (params.options ?? {}) as Record<string, unknown>,
      texts: [],
    };
    calls.push(call);

    const frames: unknown[] = [];
    let waiters: Array<() => void> = [];
    let done = false;
    let delivered = 0;
    const wake = () => {
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
    };

    // Mirror of the SDK's streamInput loop: consume the prompt iterable,
    // script a response per received user message.
    void (async () => {
      let turn = 0;
      try {
        for await (const msg of params.prompt) {
          turn += 1;
          const content = (msg as { message: { content: string } }).message
            .content;
          call.texts.push(content);
          for (const frame of script[turn] ?? []) frames.push(frame);
          wake();
        }
      } finally {
        done = true;
        wake();
      }
    })();

    const q = {
      interrupt: async () => {
        // Real CLIs answer interrupts with a belated error-result frame.
        frames.push({
          type: "result",
          subtype: "error_during_execution",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: true,
          num_turns: 1,
          result: "",
          stop_reason: null,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          errors: ["Request interrupted by user"],
          session_id: "s1",
          uuid: "u-belated",
        });
        wake();
        return undefined;
      },
      setModel: async (model?: string) => {
        setModelCalls.push(model);
      },
      close: () => {
        closed.count += 1;
        done = true;
        wake();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (frames.length > 0) {
            delivered += 1;
            yield frames.shift() as never;
            if (behavior.endsAfter !== undefined && delivered >= behavior.endsAfter) {
              return; // the CLI process died mid-turn
            }
          }
          if (done) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    };
    return q as never;
  };

  return { factory, calls, closed, setModelCalls };
}

const ASSISTANT_FRAME = (text: string): unknown => ({
  type: "assistant",
  message: { role: "assistant", model: "claude-x", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  uuid: "u1",
  session_id: "s1",
});

/** A partial text delta as it actually arrives on the wire (stream_event). */
const TEXT_DELTA = (text: string): unknown => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  parent_tool_use_id: null,
  uuid: "u-delta",
  session_id: "s1",
});

const RESULT_FRAME: unknown = {
  type: "result",
  subtype: "success",
  duration_ms: 5,
  duration_api_ms: 5,
  is_error: false,
  num_turns: 1,
  result: "hello",
  stop_reason: "end_turn",
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
  permission_denials: [],
  session_id: "s1",
  uuid: "u2",
};

// The real wire order with includePartialMessages: partial deltas first (the
// mapper emits text from THEM), then the full assistant message (text blocks
// suppressed in partial mode — deltas own delivery), then the result frame.
/** Init frame as the CLI emits it before every turn (session metadata). */
const INIT_FRAME: unknown = {
  type: "system",
  subtype: "init",
  apiKeySource: "oauth",
  claude_code_version: "2.1.322",
  cwd: "/tmp",
  tools: [],
  mcp_servers: {},
  slash_commands: [],
  session_id: "s1",
  uuid: "u0",
};

const OK_TURN: Record<number, unknown[]> = {
  1: [TEXT_DELTA("hello"), ASSISTANT_FRAME("hello"), RESULT_FRAME],
};

/** A turn that never completes on its own (for busy/interrupt states). */
const NEVER_ENDS: Record<number, unknown[]> = {
  1: [TEXT_DELTA("working…")],
};

const GET_OPTS = { cwd: "/tmp", model: null, resumeSessionId: null };

const sessions: PoolSession[] = [];
const pools: ClaudeSessionPool[] = [];

function mkPool(factory: QueryFactory, cap = 1): ClaudeSessionPool {
  const p = new ClaudeSessionPool(factory, cap);
  pools.push(p);
  return p;
}

function track(session: PoolSession): PoolSession {
  sessions.push(session);
  return session;
}

async function collect(session: PoolSession): Promise<TurnEvent[]> {
  const got: TurnEvent[] = [];
  session.onEvent((e) => got.push(e));
  return got;
}

/** Macrotask flush — drains all pending pump microtasks deterministically. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await Promise.all(pools.map((p) => p.closeAll()));
  pools.length = 0;
  sessions.length = 0;
});

describe("session-pool", () => {
  it("starts a session per conversation and emits mapped turn events", async () => {
    const { factory } = makeFactory(OK_TURN);
    const session = track(mkPool(factory).get("conv-1", GET_OPTS));
    const got = await collect(session);
    await session.send("hi");
    await vi.waitFor(() => expect(got.length).toBeGreaterThanOrEqual(2));
    expect(got[0]).toEqual({ type: "text_delta", text: "hello" });
    expect(got[1].type).toBe("turn_end");
  });

  it("passes cwd, model, resume and pinned settings through to query() options", async () => {
    const { factory, calls } = makeFactory(OK_TURN);
    const p = mkPool(factory);
    track(p.get("conv-o", { cwd: "/w", model: "sonnet", resumeSessionId: "abc-123" }));
    const opts = calls[0].opts;
    expect(opts["cwd"]).toBe("/w");
    expect(opts["model"]).toBe("sonnet");
    expect(opts["resume"]).toBe("abc-123");
    // Ledger ruling: settingSources passed explicitly, never inherited.
    expect(opts["settingSources"]).toEqual(["user", "project", "local"]);
    // Streaming mode is what enables interrupt()/setModel(); demand it.
    expect(opts["includePartialMessages"]).toBe(true);
    expect(opts["permissionMode"]).toBe("default");
    expect(opts["permissionPrompts"]).toBe("host");
  });

  it("reuses the same session for the same conversation id", async () => {
    const { factory, calls } = makeFactory(OK_TURN);
    const p = mkPool(factory);
    const a = p.get("conv-1", GET_OPTS);
    const b = p.get("conv-1", GET_OPTS);
    expect(a).toBe(b);
    expect(calls.length).toBe(1);
  });

  it("evicts on capacity, closing the least-recently-used idle session", async () => {
    const { factory, calls, closed } = makeFactory(OK_TURN);
    const p = mkPool(factory);
    p.get("conv-1", GET_OPTS);
    p.get("conv-2", GET_OPTS);
    expect(p.size()).toBe(1);
    expect(closed.count).toBe(1);
    expect(calls.length).toBe(2);
  });

  it("rejects get() at capacity when every session is busy", async () => {
    const { factory, closed } = makeFactory(NEVER_ENDS);
    const p = mkPool(factory);
    const busy = track(p.get("conv-busy", GET_OPTS));
    await busy.send("slow");
    expect(() => p.get("conv-other", GET_OPTS)).toThrow(/capacity/i);
    expect(p.size()).toBe(1);
    expect(closed.count).toBe(0); // a running turn must never be evicted
    await busy.interrupt();
    p.get("conv-other", GET_OPTS); // now succeeds — a slot freed
    expect(p.size()).toBe(1);
  });

  it("close() removes the session and closes the query", async () => {
    const { factory, closed } = makeFactory(OK_TURN);
    const p = mkPool(factory);
    const s = p.get("conv-1", GET_OPTS);
    await s.close();
    expect(closed.count).toBe(1);
    expect(p.size()).toBe(0);
  });

  it("two sends on one session create two turns, not two queries", async () => {
    const { factory, calls } = makeFactory({ 1: OK_TURN[1], 2: OK_TURN[1].slice() });
    const session = track(mkPool(factory).get("conv-a", GET_OPTS));
    const got = await collect(session);
    await session.send("one");
    await vi.waitFor(() => expect(got.filter((e) => e.type === "turn_end").length).toBe(1));
    await session.send("two");
    await vi.waitFor(() => expect(got.filter((e) => e.type === "turn_end").length).toBe(2));
    expect(calls.length).toBe(1);
    expect(calls[0].texts).toEqual(["one", "two"]);
  });

  it("rejects a send while a turn is running", async () => {
    const { factory } = makeFactory(NEVER_ENDS);
    const session = track(mkPool(factory).get("conv-r", GET_OPTS));
    await session.send("first");
    await expect(session.send("second")).rejects.toThrow(/already running/i);
    expect(session.isRunning()).toBe(true);
  });

  it("interrupt() ends the turn as interrupted (Stop button), and is idempotent", async () => {
    const { factory } = makeFactory(NEVER_ENDS);
    const session = track(mkPool(factory).get("conv-i", GET_OPTS));
    const got = await collect(session);
    await session.send("run");
    await vi.waitFor(() => expect(got.length).toBe(1));
    await session.interrupt();
    const ends = got.filter((e) => e.type === "turn_end");
    expect(ends.length).toBe(1);
    expect((ends[0] as { reason: string }).reason).toBe("interrupted");
    expect(session.isRunning()).toBe(false);
    await session.interrupt(); // no second turn_end
    expect(got.filter((e) => e.type === "turn_end").length).toBe(1);
  });

  it("swallows the CLI's belated post-interrupt result frame (no double turn_end)", async () => {
    const { factory } = makeFactory(NEVER_ENDS);
    const session = track(mkPool(factory).get("conv-i2", GET_OPTS));
    const got = await collect(session);
    await session.send("run");
    await vi.waitFor(() => expect(got.length).toBe(1));
    await session.interrupt(); // fake queues the belated error-result on interrupt
    await flush(); // let the pump drain the belated frame
    const ends = got.filter((e) => e.type === "turn_end");
    expect(ends.length).toBe(1);
    expect((ends[0] as { reason: string }).reason).toBe("interrupted");
    expect(ends.some((e) => (e as { reason: string }).reason === "error")).toBe(false);
    expect(session.isRunning()).toBe(false);
  });

  it("emits an error turn_end when the CLI process dies mid-turn", async () => {
    const { factory } = makeFactory(NEVER_ENDS, { endsAfter: 1 });
    const session = track(mkPool(factory).get("conv-dead", GET_OPTS));
    const got = await collect(session);
    await session.send("run");
    await vi.waitFor(() => expect(got.filter((e) => e.type === "turn_end").length).toBe(1));
    const end = got.find((e) => e.type === "turn_end");
    if (!end || end.type !== "turn_end") throw new Error("no turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toMatch(/ended|exited|closed/i);
    expect(session.isRunning()).toBe(false);
    await expect(session.send("again")).rejects.toThrow(/closed|unavailable/i);
  });

  it("exposes the CLI session id once a frame carries it", async () => {
    const { factory } = makeFactory(OK_TURN);
    const session = track(mkPool(factory).get("conv-s", GET_OPTS));
    expect(session.cliSessionId()).toBeNull();
    await session.send("hi");
    await vi.waitFor(() => expect(session.cliSessionId()).toBe("s1"));
  });

  it("exposes the CLI version and credential source from the init frame", async () => {
    const INIT_TURN = { 1: [INIT_FRAME, TEXT_DELTA("hi"), RESULT_FRAME] };
    const { factory } = makeFactory(INIT_TURN);
    const session = track(mkPool(factory).get("conv-v", GET_OPTS));
    await session.send("hi");
    await vi.waitFor(() => expect(session.cliVersion()).toBe("2.1.322"));
    expect(session.apiKeySource()).toBe("oauth");
  });

  it("health() aggregates the first reported credential source and version", async () => {
    const INIT_TURN = { 1: [INIT_FRAME, TEXT_DELTA("hi"), RESULT_FRAME] };
    const { factory } = makeFactory(INIT_TURN);
    const pool = mkPool(factory, 2);
    expect(pool.health()).toEqual({ active: 0, apiKeySource: null, cliVersion: null });
    const s1 = track(pool.get("a", GET_OPTS));
    track(pool.get("b", GET_OPTS)); // no turn — has not reported yet
    await s1.send("hi");
    await vi.waitFor(() =>
      expect(pool.health()).toEqual({
        active: 2,
        apiKeySource: "oauth",
        cliVersion: "2.1.322",
      }),
    );
  });

  it("forwards setModel() to the query (model picker mid-session)", async () => {
    const { factory, setModelCalls } = makeFactory(OK_TURN);
    const session = track(mkPool(factory).get("conv-m", GET_OPTS));
    await session.setModel("opus");
    expect(setModelCalls).toEqual(["opus"]);
  });

  it("wires canUseTool: emits permission_request, maps Allow/Deny answers", async () => {
    const { factory, calls } = makeFactory(OK_TURN);
    const answers: string[] = [];
    const p = mkPool(factory, 2);
    const session = track(p.get("conv-perm", {
      cwd: "/tmp",
      model: null,
      resumeSessionId: null,
      onPermission: async (toolName) => {
        answers.push(toolName);
        return toolName === "Read"
          ? { behavior: "allow" }
          : { behavior: "deny", message: "not allowed" };
      },
    }));
    const got = await collect(session);
    const canUseTool = (calls[0].opts as { canUseTool: CanUseTool }).canUseTool;
    const signal = new AbortController().signal;
    const deny = await canUseTool(
      "Bash",
      { command: "rm -rf /" },
      { signal, toolUseID: "tu_1", requestId: "req-1" } as Parameters<CanUseTool>[2],
    );
    expect(deny).toEqual({
      behavior: "deny",
      message: "not allowed",
      interrupt: false,
      toolUseID: "tu_1",
    });
    const allow = await canUseTool(
      "Read",
      { file_path: "/a" },
      { signal, toolUseID: "tu_2", requestId: "req-2" } as Parameters<CanUseTool>[2],
    );
    expect(allow).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/a" },
      toolUseID: "tu_2",
    });
    expect(answers).toEqual(["Bash", "Read"]);
    const req = got.find((e) => e.type === "permission_request");
    if (!req || req.type !== "permission_request") throw new Error("no permission_request");
    expect(req.toolName).toBe("Bash");
    expect(req.requestId).toBe("req-1");
    expect(req.toolUseId).toBe("tu_1");
    expect(req.displayHint).toBe("Bash(rm -rf /)");
  });

  it("canUseTool denies safely when no permission handler is wired", async () => {
    const { factory, calls } = makeFactory(OK_TURN);
    mkPool(factory).get("conv-noperm", GET_OPTS);
    const canUseTool = (calls[0].opts as { canUseTool: CanUseTool }).canUseTool;
    const res = await canUseTool(
      "Read",
      { file_path: "/a" },
      {
        signal: new AbortController().signal,
        toolUseID: "t",
        requestId: "r",
      } as Parameters<CanUseTool>[2],
    );
    expect(res?.behavior).toBe("deny");
  });
});
