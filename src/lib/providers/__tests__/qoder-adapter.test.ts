import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearDummyEnv, useDummyEnv } from "../../../test/dummy-env";
import { QoderAdapter, resetQoderAdapterForTest } from "../qoder/adapter";
import type { QoderRunner } from "../qoder/session";
import type { TurnEvent } from "../types";

/**
 * Adapter seam tests for Qoder — same contract as the three before it.
 * Qoder's distinctive facts: the CLI's `--permission-prompt-tool` is not a
 * declared option (it only works through allowUnknownOption), so there is no
 * approval round trip to advertise; and its stream is Claude's, so partial
 * text IS available.
 */

const runner: QoderRunner = () => ({
  events: (async function* () {
    yield {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      parent_tool_use_id: null,
      session_id: "qses_1",
    };
  })(),
  kill: () => {},
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => useDummyEnv());
afterEach(() => {
  clearDummyEnv();
  resetQoderAdapterForTest();
});

function makeAdapter(
  overrides: {
    findBinary?: () => string | null;
    credentials?: () => Record<string, string>;
  } = {},
) {
  return new QoderAdapter({
    runner,
    findBinary: overrides.findBinary ?? (() => "/usr/bin/qoder"),
    credentials: overrides.credentials ?? (() => ({ QODER_PERSONAL_ACCESS_TOKEN: "tok" })),
    detect: async () => ({
      id: "qoder",
      status: "installed",
      path: "/usr/bin/qoder",
      version: "1.1.86",
      reason: null,
      checkedAt: 0,
    }),
  });
}

describe("qoder adapter", () => {
  it("declares its capability set honestly", () => {
    const adapter = makeAdapter();
    expect(adapter.id).toBe("qoder");
    // No per-call approval on this transport; `--permission-mode
    // bypass_permissions` is the boundary.
    expect(adapter.capabilities.interactiveToolPrompts).toBe(false);
    // The stream-json dialect carries text deltas.
    expect(adapter.capabilities.partialText).toBe(true);
    expect(adapter.capabilities.sessionResume).toBe(true);
    // `managed`, not `native`: qoder reads ~/.qoder/skills/<slug>, so the
    // store bridges per skill with a symlink (see src/lib/skills/store.ts).
    expect(adapter.capabilities.skills).toBe("managed");
    expect(adapter.capabilities.plugins).toBe(false);
  });

  it("reports installed + version + auth from detection and stored credentials", async () => {
    const adapter = makeAdapter();
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(true);
    expect(inv.version).toBe("1.1.86");
    expect(inv.authed).toBe(true);
    expect(inv.reason).toBeNull();
    expect(inv.models.length).toBeGreaterThan(0);
  });

  it("reports authed false when no credential is configured", async () => {
    const adapter = makeAdapter({ credentials: () => ({}) });
    expect((await adapter.inventory()).authed).toBe(false);
  });

  it("passes through the detection reason when the CLI is missing", async () => {
    const adapter = new QoderAdapter({
      runner,
      findBinary: () => null,
      credentials: () => ({}),
      detect: async () => ({
        id: "qoder",
        status: "missing",
        path: null,
        version: null,
        reason: "qoder is not on this server's PATH",
        checkedAt: 0,
      }),
    });
    const inv = await adapter.inventory();
    expect(inv.installed).toBe(false);
    expect(inv.version).toBeNull();
    expect(inv.reason).toBe("qoder is not on this server's PATH");
  });

  it("refuses to start a session when the binary is absent", async () => {
    const adapter = makeAdapter({ findBinary: () => null });
    await expect(adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null })).rejects.toThrow(
      /not installed/,
    );
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
      model: "qwen3.8-max",
    });
    const events: TurnEvent[] = [];
    session.onEvent((e) => events.push(e));
    await session.send("hi");
    await flush();
    expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(session.cliSessionId?.()).toBe("qses_1");
  });

  it("normalizes the UI's \"auto\" model to no override", async () => {
    const seen: string[][] = [];
    const capturing: QoderRunner = (argv) => {
      seen.push(argv);
      return {
        events: (async function* () {
          yield { type: "result", subtype: "success", is_error: false };
        })(),
        kill: () => {},
      };
    };
    const adapter = new QoderAdapter({
      runner: capturing,
      findBinary: () => "/usr/bin/qoder",
      credentials: () => ({}),
    });
    const session = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: "auto" });
    await session.send("hi");
    await flush();
    expect(seen[0]).not.toContain("-m");
  });

  it("advertises only the model the CLI actually declares, plus auto", async () => {
    const inv = await makeAdapter().inventory();
    expect(inv.models.map((m) => m.id)).toEqual(["qwen3.8-max", "auto"]);
  });

  it("forwards the session-closed hook", async () => {
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
    const blocking: QoderRunner = () => ({
      events: (async function* () {
        await gate;
        yield { type: "result", subtype: "success", is_error: false };
      })(),
      kill: () => {},
    });
    const adapter = new QoderAdapter({
      runner: blocking,
      findBinary: () => "/usr/bin/qoder",
      credentials: () => ({}),
      capacity: 1,
    });
    const running = await adapter.startsSession({ conversationId: "u:1", cwd: "/w", model: null });
    await running.send("hi");
    await expect(adapter.startsSession({ conversationId: "u:2", cwd: "/w", model: null })).rejects.toThrow(
      /capacity/,
    );
    release();
    await flush();
  });
});
