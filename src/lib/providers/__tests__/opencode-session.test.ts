import { describe, it, expect, vi } from "vitest";
import {
  OpenCodeSession,
  buildOpenCodeArgv,
  type OpenCodeRunner,
} from "../opencode/session";
import type { TurnEvent } from "../types";

/**
 * The session is written against an injectable runner so tests can script the
 * CLI's NDJSON stream. Production passes a runner that spawns the real binary
 * through the app's argv-only exec seam.
 */

interface Scripted {
  argv: string[][];
  envs: Record<string, string>[];
  inputs: string[];
  kills: number;
}

/** A runner that hands out one scripted stream per call. */
function scriptedRunner(streams: unknown[][]): { runner: OpenCodeRunner; seen: Scripted } {
  const seen: Scripted = { argv: [], envs: [], inputs: [], kills: 0 };
  let call = 0;
  const runner: OpenCodeRunner = (argv, opts) => {
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

function collect(session: OpenCodeSession): TurnEvent[] {
  const out: TurnEvent[] = [];
  session.onEvent((e) => out.push(e));
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function textFrame(text: string) {
  return {
    type: "text",
    timestamp: 2,
    sessionID: "ses_1",
    part: { id: "p1", sessionID: "ses_1", messageID: "m1", type: "text", text },
  };
}

function stepFrame() {
  return {
    type: "step_finish",
    timestamp: 3,
    sessionID: "ses_1",
    part: {
      id: "p2",
      sessionID: "ses_1",
      messageID: "m1",
      type: "step-finish",
      cost: 0.004,
      tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

describe("opencode session", () => {
  it("builds a json-format argv that auto-approves and never takes the prompt on argv", () => {
    const argv = buildOpenCodeArgv({ cwd: "/work", model: "anthropic/claude-sonnet-4", resume: null });
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--format");
    expect(argv[argv.indexOf("--format") + 1]).toBe("json");
    // Without --auto the CLI rejects every permission request and the turn is
    // worthless; there is no interactive prompt on this transport.
    expect(argv).toContain("--auto");
    expect(argv).toContain("--thinking");
    expect(argv.join(" ")).toContain("-m anthropic/claude-sonnet-4");
    expect(argv).not.toContain("-s");
    // The prompt goes over stdin: argv is visible in the process table.
    expect(argv).not.toContain("--prompt");
    expect(argv).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--thinking",
      "-m",
      "anthropic/claude-sonnet-4",
    ]);
  });

  it("resumes by session id", () => {
    const argv = buildOpenCodeArgv({ cwd: "/work", model: null, resume: "ses_9" });
    expect(argv.slice(-2)).toEqual(["-s", "ses_9"]);
    expect(argv).not.toContain("-m");
  });

  it("streams mapped events and finishes a cleanly exited turn as done", async () => {
    const { runner } = scriptedRunner([[textFrame("hel"), textFrame("lo"), stepFrame()]]);
    const session = new OpenCodeSession({ cwd: "/work", model: "anthropic/claude-sonnet-4", runner, env: {} });
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
    expect(end.costUsd).toBe(0.004);
    expect(end.tokens).toEqual({ input: 10, output: 4 });
    expect(session.isRunning()).toBe(false);
    expect(session.cliSessionId()).toBe("ses_1");
  });

  it("writes the prompt to stdin and points the child's PWD at the workspace", async () => {
    const { runner, seen } = scriptedRunner([[]]);
    const session = new OpenCodeSession({ cwd: "/work", model: null, runner, env: {} });
    await session.send("please fix the tests");
    await flush();
    expect(seen.inputs[0]).toBe("please fix the tests");
    // OpenCode resolves its working directory from PWD, not by calling
    // getcwd. An inherited PWD would silently run the agent in the server's
    // own directory instead of the conversation's workspace.
    expect(seen.envs[0].PWD).toBe("/work");
  });

  it("resumes the captured session on the next turn", async () => {
    const { runner, seen } = scriptedRunner([[textFrame("one")], []]);
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await flush();
    await session.send("two");
    await flush();
    expect(seen.argv[0]).not.toContain("-s");
    expect(seen.argv[1].slice(-2)).toEqual(["-s", "ses_1"]);
  });

  it("resumes the id the conversation remembered on the first turn", async () => {
    const { runner, seen } = scriptedRunner([[textFrame("hi")]]);
    const session = new OpenCodeSession({
      cwd: "/w",
      model: null,
      resumeSessionId: "ses_old",
      runner,
      env: {},
    });
    await session.send("hi");
    await flush();
    expect(seen.argv[0].slice(-2)).toEqual(["-s", "ses_old"]);
    expect(session.cliSessionId()).toBe("ses_1");
  });

  it("rejects a second send while a turn is running", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: OpenCodeRunner = () => ({
      events: (async function* () {
        await gate;
        yield textFrame("done");
      })(),
      kill: () => {},
    });
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await expect(session.send("two")).rejects.toThrow(/already running/);
    release();
    await flush();
  });

  it("rejects send after close", async () => {
    const { runner } = scriptedRunner([[]]);
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    await session.close();
    await expect(session.send("hi")).rejects.toThrow(/closed/);
  });

  it("ends the turn as an error when the process fails without an error frame", async () => {
    const runner: OpenCodeRunner = () => ({
      events: (async function* () {
        yield textFrame("partial");
        throw new Error("opencode exited 1: no provider configured");
      })(),
      kill: () => {},
    });
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toContain("no provider configured");
  });

  it("does not double-end a turn whose error frame already reported it", async () => {
    const runner: OpenCodeRunner = () => ({
      events: (async function* () {
        yield { type: "error", timestamp: 5, sessionID: "ses_1", error: { type: "unknown", message: "boom" } };
        throw new Error("opencode exited 1: boom");
      })(),
      kill: () => {},
    });
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.error).toBe("boom");
  });

  it("turns a synchronous spawn failure into an error turn_end", async () => {
    const runner: OpenCodeRunner = () => {
      throw new Error("opencode is not installed on this server");
    };
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
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
    const runner: OpenCodeRunner = () => ({
      events: (async function* () {
        yield textFrame("thinking out loud");
        await new Promise<void>(() => {
          // never resolves: the turn is killed, not completed
        });
      })(),
      kill,
    });
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
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
    const session = new OpenCodeSession({ cwd: "/w", model: "openai/gpt-5", runner, env: {} });
    await session.send("one");
    await flush();
    await session.setModel("anthropic/claude-sonnet-4");
    await session.send("two");
    await flush();
    expect(seen.argv[0].join(" ")).toContain("-m openai/gpt-5");
    expect(seen.argv[1].join(" ")).toContain("-m anthropic/claude-sonnet-4");
  });

  it("passes the credential env to the CLI, keeping the host PATH", async () => {
    const { runner, seen } = scriptedRunner([[]]);
    const session = new OpenCodeSession({
      cwd: "/w",
      model: null,
      runner,
      env: { OPENCODE_API_KEY: "test-not-real" },
    });
    await session.send("hi");
    await flush();
    expect(seen.envs[0].OPENCODE_API_KEY).toBe("test-not-real");
    expect(seen.envs[0].PATH).toBe(process.env.PATH);
  });

  it("survives a listener that throws", async () => {
    const { runner } = scriptedRunner([[]]);
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {} });
    session.onEvent(() => {
      throw new Error("listener boom");
    });
    const seen: TurnEvent[] = [];
    session.onEvent((e) => seen.push(e));
    await session.send("hi");
    await flush();
    expect(seen.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  it("notifies the owner on close, before anything else", async () => {
    const { runner } = scriptedRunner([[]]);
    const onSessionClosed = vi.fn();
    const session = new OpenCodeSession({ cwd: "/w", model: null, runner, env: {}, onSessionClosed });
    await session.close();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });
});
