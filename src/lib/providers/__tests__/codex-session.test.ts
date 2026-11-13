import { describe, it, expect, vi } from "vitest";
import { CodexSession, buildCodexArgv, type CodexRunner } from "../codex/session";
import type { TurnEvent } from "../types";

/**
 * The session is written against an injectable runner so tests can script the
 * CLI's JSONL stream. Production passes a runner that spawns the real binary
 * through the app's argv-only exec seam.
 */

interface Scripted {
  argv: string[][];
  envs: Record<string, string>[];
  kills: number;
}

/** A runner that hands out one scripted stream per call. */
function scriptedRunner(streams: unknown[][]): { runner: CodexRunner; seen: Scripted } {
  const seen: Scripted = { argv: [], envs: [], kills: 0 };
  let call = 0;
  const runner: CodexRunner = (argv, opts) => {
    seen.argv.push(argv);
    seen.envs.push(opts.env);
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

function collect(session: CodexSession): TurnEvent[] {
  const out: TurnEvent[] = [];
  session.onEvent((e) => out.push(e));
  return out;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("codex session", () => {
  it("builds an argv-only exec command with explicit sandbox and approval policy", () => {
    const argv = buildCodexArgv({ cwd: "/work", model: "gpt-5-codex", resume: null });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--experimental-json");
    expect(argv.join(" ")).toContain("--sandbox workspace-write");
    expect(argv.join(" ")).toContain('approval_policy="never"');
    expect(argv.join(" ")).toContain("sandbox_workspace_write.network_access=true");
    expect(argv.join(" ")).toContain("--cd /work");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv.join(" ")).toContain("--model gpt-5-codex");
    expect(argv).not.toContain("resume");
  });

  it("resumes a thread by id instead of starting a new one", () => {
    const argv = buildCodexArgv({ cwd: "/work", model: null, resume: "th-9" });
    expect(argv.slice(-2)).toEqual(["resume", "th-9"]);
    expect(argv).not.toContain("--model");
  });

  it("streams mapped events to listeners and ends the turn once", async () => {
    const { runner } = scriptedRunner([
      [
        { type: "thread.started", thread_id: "th-1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "i1", type: "agent_message", text: "hello" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 },
        },
      ],
    ]);
    const session = new CodexSession({
      cwd: "/work",
      model: "gpt-5-codex",
      runner,
      env: {},
    });
    const events = collect(session);
    await session.send("hi");
    await flush();

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "hello" },
    ]);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
    expect(session.isRunning()).toBe(false);
    expect(session.cliSessionId()).toBe("th-1");
  });

  it("resumes the captured thread on the next turn", async () => {
    const { runner, seen } = scriptedRunner([
      [
        { type: "thread.started", thread_id: "th-1" },
        { type: "turn.completed", usage: {} },
      ],
      [{ type: "turn.completed", usage: {} }],
    ]);
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await flush();
    await session.send("two");
    await flush();
    expect(seen.argv[0]).not.toContain("resume");
    expect(seen.argv[1].slice(-2)).toEqual(["resume", "th-1"]);
  });

  it("starts a fresh thread when the conversation supplied no resume id", async () => {
    const { runner, seen } = scriptedRunner([
      [{ type: "thread.started", thread_id: "th-2" }, { type: "turn.completed", usage: {} }],
    ]);
    const session = new CodexSession({
      cwd: "/w",
      model: null,
      resumeSessionId: "th-old",
      runner,
      env: {},
    });
    await session.send("hi");
    await flush();
    expect(seen.argv[0].slice(-2)).toEqual(["resume", "th-old"]);
    expect(session.cliSessionId()).toBe("th-2");
  });

  it("rejects a second send while a turn is running", async () => {
    // Typed as a plain function variable, not as `(() => void) | null`: the
    // assignment happens when the executor below runs, which the compiler
    // cannot see, so a nullable type would narrow to `null` and make the
    // release call a call on `never`. The gate is created up front so the
    // generator can never await a promise the test has not made yet.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runner: CodexRunner = () => ({
      events: (async function* () {
        await gate;
        yield { type: "turn.completed", usage: {} };
      })(),
      kill: () => {},
    });
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
    await session.send("one");
    await expect(session.send("two")).rejects.toThrow(/already running/);
    release();
    await flush();
  });

  it("rejects send after close", async () => {
    const { runner } = scriptedRunner([[{ type: "turn.completed", usage: {} }]]);
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
    await session.close();
    await expect(session.send("hi")).rejects.toThrow(/closed/);
  });

  it("ends a turn that dies without a terminal frame as an error", async () => {
    const { runner } = scriptedRunner([
      [
        { type: "thread.started", thread_id: "th-3" },
        { type: "item.completed", item: { id: "i1", type: "agent_message", text: "partial" } },
      ],
    ]);
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
    const events = collect(session);
    await session.send("hi");
    await flush();
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toMatch(/ended unexpectedly/);
  });

  it("interrupts the running CLI process and ends the turn as interrupted", async () => {
    const kill = vi.fn();
    const runner: CodexRunner = () => ({
      events: (async function* () {
        yield { type: "turn.started" };
        await new Promise<void>(() => {
          // never resolves: the turn is killed, not completed
        });
      })(),
      kill,
    });
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
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
    const { runner, seen } = scriptedRunner([
      [{ type: "turn.completed", usage: {} }],
      [{ type: "turn.completed", usage: {} }],
    ]);
    const session = new CodexSession({ cwd: "/w", model: "gpt-5", runner, env: {} });
    await session.send("one");
    await flush();
    await session.setModel("gpt-5-codex");
    await session.send("two");
    await flush();
    expect(seen.argv[0].join(" ")).toContain("--model gpt-5");
    expect(seen.argv[1].join(" ")).toContain("--model gpt-5-codex");
  });

  it("passes the credential env to the CLI, keeping the host PATH", async () => {
    const { runner, seen } = scriptedRunner([[{ type: "turn.completed", usage: {} }]]);
    const session = new CodexSession({
      cwd: "/w",
      model: null,
      runner,
      env: { OPENAI_API_KEY: "sk-test-not-real" },
    });
    await session.send("hi");
    await flush();
    expect(seen.envs[0].OPENAI_API_KEY).toBe("sk-test-not-real");
    expect(seen.envs[0].PATH).toBe(process.env.PATH);
  });

  it("survives a listener that throws", async () => {
    const { runner } = scriptedRunner([[{ type: "turn.completed", usage: {} }]]);
    const session = new CodexSession({ cwd: "/w", model: null, runner, env: {} });
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
    const { runner } = scriptedRunner([[{ type: "turn.completed", usage: {} }]]);
    const onSessionClosed = vi.fn();
    const session = new CodexSession({
      cwd: "/w",
      model: null,
      runner,
      env: {},
      onSessionClosed,
    });
    await session.close();
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });
});
