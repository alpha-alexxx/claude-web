import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearDummyEnv, useDummyEnv } from "../../../test/dummy-env";
import { OpenCodeAdapter, resetOpenCodeAdapterForTest } from "../opencode/adapter";
import type { OpenCodeRunner } from "../opencode/session";
import type { TurnEvent } from "../types";

/**
 * Adapter seam tests for OpenCode. Same contract as Claude's and Codex's
 * suites: what the UI can promise through `ActiveSession`, plus OpenCode's
 * distinctive fact — it has no per-call approval on the `run` transport, so
 * `interactiveToolPrompts` is false and `--auto` is the boundary.
 */

const runner: OpenCodeRunner = () => ({
  events: (async function* () {
    yield {
      type: "text",
      timestamp: 1,
      sessionID: "ses_1",
      part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text: "hi" },
    };
  })(),
  kill: () => {},
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => useDummyEnv());
afterEach(() => {
  clearDummyEnv();
  resetOpenCodeAdapterForTest();
});

function makeAdapter(overrides: {
  findBinary?: () => string | null;
  credentials?: () => Record<string, string>;
} = {}) {
  return new OpenCodeAdapter({
    runner,
    findBinary: overrides.findBinary ?? (() => "/usr/bin/opencode"),
    credentials: overrides.credentials ?? (() => ({ OPENCODE_API_KEY: "sk-test" })),
    detect: async () => ({
      id: "opencode",
      status: "installed",
      path: "/usr/bin/opencode",
      version: "2.2.6",
      reason: null,
      checkedAt: 0,
    }),
  });
}

describe("opencode adapter", () => {
  it("declares its capability set honestly", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("opencode");
    expect(adapter.capabilities.interactiveToolPrompts).toBe(false);
    expect(adapter.capabilities.partialText).toBe(true);
    expect(adapter.capabilities.sessionResume).toBe(true);
    expect(adapter.capabilities.skills).toBe("native");
    expect(adapter.capabilities.plugins).toBe(false);
  });

  it("reports installed + version + auth from detection and stored credentials", async () => {
    const adapter = makeAdapter({ credentials: () => ({ OPENCODE_API_KEY: "sk-test" }) });
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(true);
    expect(inv.version).toBe("2.2.6");
    expect(inv.authed).toBe(true);
    expect(inv.reason).toBeNull();
    expect(inv.models.length).toBeGreaterThan(0);
  });

  it("reports authed false when no credential is configured", async () => {
    const adapter = makeAdapter({ credentials: () => ({}) });
    expect((await adapter.inventory()).authed).toBe(false);
  });

  it("passes through the detection reason when the CLI is missing", async () => {
    const adapter = new OpenCodeAdapter({
      runner,
      findBinary: () => null,
      credentials: () => ({}),
      detect: async () => ({
        id: "opencode",
        status: "missing",
        path: null,
        version: null,
        reason: "opencode is not on this server's PATH",
        checkedAt: 0,
      }),
    });
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(false);
    expect(inv.version).toBeNull();
    expect(inv.reason).toBe("opencode is not on this server's PATH");
  });

  it("refuses to start a session when the binary is absent", async () => {
    const adapter = makeAdapter({ findBinary: () => null });
    await expect(
      adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null }),
    ).rejects.toThrow(/not installed/);
  });

  it("returns one session per conversation and reuses it across turns", async () => {
    const adapter = makeAdapter();
    const a = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    const b = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    expect(a).toBe(b);
    const other = await adapter.startsSession({ conversationId: "u:2", cwd: "/w", model: null });
    expect(other).not.toBe(a);
  });

  it("exposes a live session only for a conversation it has started", async () => {
    const adapter = makeAdapter();
    expect(adapter.liveSession("u:1")).toBeNull();
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    expect(adapter.liveSession("u:1")).toBe(session);
  });

  it("streams the turn through the ActiveSession contract", async () => {
    const adapter = makeAdapter();
    const session = await adapter.startsSession({
      conversationId: "u:1",
      cwd: "/w",
      model: "anthropic/claude-sonnet-4",
    });
    const events: TurnEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    await flush();
    expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(session.cliSessionId?.()).toBe("ses_1");
  });

  it("normalizes the UI's \"auto\" model to no override", async () => {
    const seen: string[][] = [];
    const capturing: OpenCodeRunner = (argv) => {
      seen.push(argv);
      return {
        events: (async function* () {
          yield { type: "step_finish", sessionID: "ses_1" };
        })(),
        kill: () => {},
      };
    };
    const adapter = new OpenCodeAdapter({
      runner: capturing,
      findBinary: () => "/usr/bin/opencode",
      credentials: () => ({}),
    });
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: "auto" });
    await session.send("hi");
    await flush();
    expect(seen[0]).not.toContain("-m");
  });

  it("forwards the session-closed hook so pending prompts can be denied", async () => {
    const onSessionClosed = vi.fn();
    const adapter = makeAdapter();
    const session = await adapter.startsSession({
      conversationId: "u:1",
      cwd: "/w",
      model: null,
      onSessionClosed,
    });
    await session.close();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it("drops the session from the live index on close", async () => {
    const adapter = makeAdapter();
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    await session.close();
    expect(adapter.liveSession("u:1")).toBeNull();
  });

  it("never evicts a conversation that is mid-turn when at capacity", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking: OpenCodeRunner = () => ({
      events: (async function* () {
        await gate;
        yield { type: "step_finish", sessionID: "ses_1" };
      })(),
      kill: () => {},
    });
    const adapter = new OpenCodeAdapter({
      runner: blocking,
      findBinary: () => "/usr/bin/opencode",
      credentials: () => ({}),
      capacity: 1,
    });
    const running = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    await running.send("hi");
    await expect(
      adapter.startsSession({ conversationId: "u:2", cwd: "/w", model: null }),
    ).rejects.toThrow(/capacity/);
    release();
    await flush();
  });
});
