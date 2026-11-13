import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearDummyEnv, useDummyEnv } from "../../../test/dummy-env";
import { CodexAdapter, resetCodexAdapterForTest } from "../codex/adapter";
import type { CodexRunner } from "../codex/session";
import type { TurnEvent } from "../types";

/**
 * Adapter seam tests for Codex. Same contract as Claude's suite: what the UI
 * can promise through `ActiveSession`, plus Codex's two distinctive facts —
 * it has no per-call approval (capability flag false) and its process is
 * per-turn, so the session object (not a process) is what persists.
 */

const runner: CodexRunner = () => ({
  events: (async function* () {
    yield { type: "thread.started", thread_id: "th-1" };
    yield { type: "turn.completed", usage: {} };
  })(),
  kill: () => {},
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => useDummyEnv());
afterEach(() => {
  clearDummyEnv();
  resetCodexAdapterForTest();
});

function makeAdapter(overrides: {
  findBinary?: () => string | null;
  credentials?: () => Record<string, string>;
  onSessionClosed?: () => void;
} = {}) {
  return new CodexAdapter({
    runner,
    findBinary: overrides.findBinary ?? (() => "/usr/bin/codex"),
    credentials: overrides.credentials ?? (() => ({ OPENAI_API_KEY: "sk-test" })),
    detect: async () => ({
      id: "codex",
      status: "installed",
      path: "/usr/bin/codex",
      version: "0.167.0",
      reason: null,
      checkedAt: 0,
    }),
  });
}

describe("codex adapter", () => {
  it("declares its capability set honestly", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities.interactiveToolPrompts).toBe(false);
    expect(adapter.capabilities.partialText).toBe(false);
    expect(adapter.capabilities.sessionResume).toBe(true);
    expect(adapter.capabilities.skills).toBe("native");
    expect(adapter.capabilities.plugins).toBe(false);
  });

  it("reports installed + version + auth from detection and stored credentials", async () => {
    const adapter = makeAdapter({ credentials: () => ({ OPENAI_API_KEY: "sk-test" }) });
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(true);
    expect(inv.version).toBe("0.167.0");
    expect(inv.authed).toBe(true);
    expect(inv.reason).toBeNull();
    expect(inv.models.length).toBeGreaterThan(0);
  });

  it("reports authed false when no credential is configured", async () => {
    const adapter = makeAdapter({ credentials: () => ({}) });
    expect((await adapter.inventory()).authed).toBe(false);
  });

  it("passes through the detection reason when the CLI is missing", async () => {
    const adapter = new CodexAdapter({
      runner,
      findBinary: () => null,
      credentials: () => ({}),
      detect: async () => ({
        id: "codex",
        status: "missing",
        path: null,
        version: null,
        reason: "codex is not on this server's PATH",
        checkedAt: 0,
      }),
    });
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(false);
    expect(inv.version).toBeNull();
    expect(inv.reason).toBe("codex is not on this server's PATH");
  });

  it("refuses to start a session when the binary is absent", async () => {
    const adapter = makeAdapter({ findBinary: () => null });
    await expect(
      adapter.startsSession({
        conversationId: "u:1",
        cwd: "/w",
        model: null,
      }),
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
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: "gpt-5" });
    const events: TurnEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    await flush();
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(session.cliSessionId?.()).toBe("th-1");
    session.offEvent(() => {});
  });

  it("normalizes the UI's \"auto\" model to no override", async () => {
    const seen: string[][] = [];
    const capturing: CodexRunner = (argv) => {
      seen.push(argv);
      return {
        events: (async function* () {
          yield { type: "turn.completed", usage: {} };
        })(),
        kill: () => {},
      };
    };
    const adapter = new CodexAdapter({
      runner: capturing,
      findBinary: () => "/usr/bin/codex",
      credentials: () => ({}),
    });
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: "auto" });
    await session.send("hi");
    await flush();
    expect(seen[0]).not.toContain("--model");
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
    // Same up-front gate as the session test: the resolver exists before the
    // generator is created, so `release` is never a placeholder.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blocking: CodexRunner = () => ({
      events: (async function* () {
        await gate;
        yield { type: "turn.completed", usage: {} };
      })(),
      kill: () => {},
    });
    const adapter = new CodexAdapter({
      runner: blocking,
      findBinary: () => "/usr/bin/codex",
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
