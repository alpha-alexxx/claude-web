import { describe, it, expect, vi } from "vitest";
import { QoderSession, buildQoderArgv, type QoderRunner } from "../qoder/session";
import type { TurnEvent } from "../types";

/**
 * Qoder is the third per-turn CLI behind the seam. Its transport is Claude's
 * own stream-json dialect (the frames carry `session_id`, `tool_use` and
 * `tool_result`), but — like `codex exec` and `opencode run` — it takes the
 * prompt on stdin, streams, and exits. So the session shape matches Codex's
 * while the mapper shapes match Claude's.
 */

interface Scripted {
  argv: string[][];
  envs: Record<string, string>[];
  inputs: string[];
  kills: number;
}

function scriptedRunner(streams: unknown[][]): { runner: QoderRunner; seen: Scripted } {
  const seen: Scripted = { argv: [], envs: [], inputs: [], kills: 0 };
  let call = 0;
  const runner: QoderRunner = (argv, opts) => {
    seen.argv.push(argv);
    seen.envs.push(opts.env);
    seen.inputs.push(opts.input);
    const frames = streams[Math.min(call++, streams.length - 1)] ?? [];
    return {
      events: (async function* () {
        for (const f of frames) yield f;
      })(),
      kill: () => {
        seen.kills += 1;
      },
    };
  };
  return { runner, seen };
}

function collect(session: QoderSession): TurnEvent[] {
  const out: TurnEvent[] = [];
  session.onEvent((e) => out.push(e));
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A stream_event text delta exactly as qodercli 1.1.86 frames it. */
function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: "u1",
    session_id: "qses_1",
  };
}

/** The terminal frame; `total_cost_usd` is hardcoded 0 by the CLI. */
function resultFrame(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    is_error: false,
    result: "ok",
    total_cost_usd: 0,
    total_credits: 3,
    usage: { input_tokens: 11, output_tokens: 5 },
    session_id: "qses_1",
    ...overrides,
  };
}

describe("qoder session", () => {
  it("builds a print/stream-json argv that never waits for approval", () => {
    const argv = buildQoderArgv({ cwd: "/work", model: "qwen3.8-max", resume: null });
    expect(argv).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypass_permissions",
      "--cwd",
      "/work",
      "-m",
      "qwen3.8-max",
    ]);
    // The prompt goes over stdin: argv is world-readable in the process table.
    expect(argv).not.toContain("--permission-prompt-tool");
    // `dont_ask` denies every tool; `auto` needs a classifier and denies when
    // unavailable. Neither can run a coding turn unattended.
    expect(argv).not.toContain("dont_ask");
    expect(argv).not.toContain("auto");
  });

  it("resumes by session id and omits the model when there is none", () => {
    const argv = buildQoderArgv({ cwd: "/work", model: null, resume: "qses_9" });
    expect(argv.slice(-2)).toEqual(["--resume", "qses_9"]);
    expect(argv).not.toContain("-m");
  });

  it("streams mapped events and finishes a cleanly exited turn as done", async () => {
    const { runner } = scriptedRunner([[textDelta("hel"), textDelta("lo"), resultFrame()]]);
    const session = new QoderSession({ cwd: "/work", model: "qwen3.8-max", runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ]);
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("done");
    expect(end.tokens).toEqual({ input: 11, output: 5 });
    // total_cost_usd is HARDCODED 0 in qodercli and the real figure is
    // total_credits, which is not dollars. Reporting 0 would render the turn
    // as free; null says "unknown".
    expect(end.costUsd).toBeNull();
    expect(session.isRunning()).toBe(false);
    expect(session.cliSessionId()).toBe("qses_1");
  });

  it("writes the prompt to stdin and points the child's PWD at the workspace", async () => {
    const { runner, seen } = scriptedRunner([[]]);
    const session = new QoderSession({ cwd: "/work", model: null, runner, env: {} });
    await session.send("please fix the tests");
    await flush();
    expect(seen.inputs[0]).toBe("please fix the tests");
    expect(seen.envs[0].PWD).toBe("/work");
  });

  it("resumes the captured session on the next turn", async () => {
    const { runner, seen } = scriptedRunner([[textDelta("one")], []]);
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await flush();
    await session.send("two");
    await flush();
    expect(seen.argv[0]).not.toContain("--resume");
    expect(seen.argv[1].slice(-2)).toEqual(["--resume", "qses_1"]);
  });

  it("resumes the id the conversation remembered on the first turn", async () => {
    const { runner, seen } = scriptedRunner([[textDelta("hi")]]);
    const session = new QoderSession({
      cwd: "/w",
      model: null,
      resumeSessionId: "qses_old",
      runner,
      env: {},
    });
    await session.send("hi");
    await flush();
    expect(seen.argv[0].slice(-2)).toEqual(["--resume", "qses_old"]);
    expect(session.cliSessionId()).toBe("qses_1");
  });

  it("rejects a second send while a turn is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: QoderRunner = () => ({
      events: (async function* () {
        await gate;
        yield textDelta("done");
      })(),
      kill: () => {},
    });
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await expect(session.send("two")).rejects.toThrow(/already running/);
    release();
    await flush();
  });

  it("rejects send after close", async () => {
    const { runner } = scriptedRunner([[]]);
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    await session.close();
    await expect(session.send("hi")).rejects.toThrow(/closed/);
  });

  it("ends the turn as an error when the process fails without a result frame", async () => {
    const runner: QoderRunner = () => ({
      events: (async function* () {
        yield textDelta("partial");
        throw new Error('qoder exited 1: unknown option "--nope"');
      })(),
      kill: () => {},
    });
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toContain("unknown option");
  });

  it("does not double-end a turn whose error result frame already reported it", async () => {
    const runner: QoderRunner = () => ({
      events: (async function* () {
        yield resultFrame({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["model refused"],
        });
        throw new Error("qoder exited 1: model refused");
      })(),
      kill: () => {},
    });
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toBe("model refused");
  });

  it("turns a synchronous spawn failure into an error turn_end", async () => {
    const runner: QoderRunner = () => {
      throw new Error("qoder is not installed on this server");
    };
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toContain("not installed");
  });

  it("interrupts the running CLI process and ends the turn as interrupted", async () => {
    const kill = vi.fn();
    const runner: QoderRunner = () => ({
      events: (async function* () {
        yield textDelta("thinking out loud");
        await new Promise<void>(() => {
          // never resolves: the turn is killed, not completed
        });
      })(),
      kill,
    });
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await session.interrupt();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("interrupted");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(session.isRunning()).toBe(false);
  });

  it("applies a model switch on the next turn, not the running one", async () => {
    const { runner, seen } = scriptedRunner([[], []]);
    const session = new QoderSession({ cwd: "/w", model: "qwen3.8-max", runner, env: {} });
    await session.send("one");
    await flush();
    await session.setModel("qwen3.8-max-preview");
    await session.send("two");
    await flush();
    expect(seen.argv[0].join(" ")).toContain("-m qwen3.8-max");
    expect(seen.argv[1].join(" ")).toContain("-m qwen3.8-max-preview");
  });

  it("passes the credential env to the CLI, keeping the host PATH", async () => {
    const { runner, seen } = scriptedRunner([[]]);
    const session = new QoderSession({
      cwd: "/w",
      model: null,
      runner,
      env: { QODER_PERSONAL_ACCESS_TOKEN: "test-not-real" },
    });
    await session.send("hi");
    await flush();
    expect(seen.envs[0].QODER_PERSONAL_ACCESS_TOKEN).toBe("test-not-real");
    expect(seen.envs[0].PATH).toBe(process.env.PATH);
  });

  it("survives a listener that throws", async () => {
    const { runner } = scriptedRunner([[]]);
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {} });
    session.onEvent(() => {
      throw new Error("listener boom");
    });
    const seen: TurnEvent[] = [];
    session.onEvent((e) => seen.push(e));
    await session.send("hi");
    await flush();
    expect(seen.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  it("notifies the owner on close", async () => {
    const { runner } = scriptedRunner([[]]);
    const onSessionClosed = vi.fn();
    const session = new QoderSession({ cwd: "/w", model: null, runner, env: {}, onSessionClosed });
    await session.close();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });
});
