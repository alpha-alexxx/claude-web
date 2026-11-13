import {
  finishOpenCodeTurn,
  mapOpenCodeEvent,
  newOpenCodeTurnState,
  type OpenCodeTurnState,
} from "./message-mapper";
import type { TurnEvent } from "../types";

/**
 * One `opencode run` process per TURN.
 *
 * OpenCode has no streaming-input mode either: `run` takes the prompt on
 * stdin, writes NDJSON to stdout when `--format json` is set, and exits when
 * the turn is over. Continuity comes from the session id echoed on every
 * frame (`-s <id>` on the next turn), not from a long-lived process. So, as
 * with Codex:
 *
 *   - at most ONE in-flight process per conversation; `send()` rejects while
 *     it runs (the route serialises turns anyway);
 *   - `interrupt()` kills the process — the only way to stop it;
 *   - `setModel()` stores the choice for the NEXT spawn;
 *   - the session object outlives its processes; the session id and the
 *     listener set are the state that survives.
 *
 * The process itself is reached through `OpenCodeRunner`, injected here so the
 * session is testable without a CLI on the host.
 */

/** Options handed to a runner for one turn. */
export interface OpenCodeRunOpts {
  /** Environment for the child: host env plus provider credentials. */
  env: Record<string, string>;
  /** Working directory (already contained by the chat route). */
  cwd: string;
  /** The user's prompt, written to the child's stdin. */
  input: string;
  /** Ends the turn's stream (timeout / Stop). */
  kill: () => void;
}

/** Streamed NDJSON frames from one `opencode run` invocation. */
export interface OpenCodeRun {
  events: AsyncIterable<unknown>;
  /** SIGTERM the process (and its group); the pump sees the stream end. */
  kill: () => void;
}

export type OpenCodeRunner = (argv: string[], opts: OpenCodeRunOpts) => OpenCodeRun;

/**
 * RULED defaults, not user-configurable yet:
 *
 *   --format json   — the only machine-readable output OpenCode offers.
 *   --auto          — MANDATORY on this transport. Without it the CLI's
 *                     permission handler answers `reject` to every request
 *                     (`decision: input.auto ? "once" : "reject"`), so every
 *                     tool call fails and the turn is worthless. There is no
 *                     interactive prompt to route here either way.
 *   --thinking      — surfaces the model's reasoning frames, which the mapper
 *                     renders as thinking deltas like Claude's.
 *
 * The prompt is NOT placed on argv: argv is world-readable in the process
 * table, and passing a message argument switches the CLI to
 * `readStdinIfReady(1000)` instead of the full stdin read, which would risk
 * truncating a long prompt.
 *
 * `cwd` is not a flag here: `run` has no directory option (the root takes it
 * as a positional), so the working directory reaches the CLI through the
 * spawn cwd and the child's PWD.
 */
export function buildOpenCodeArgv(opts: {
  cwd: string;
  model: string | null;
  resume: string | null;
}): string[] {
  const argv = ["run", "--format", "json", "--auto", "--thinking"];
  if (opts.model) argv.push("-m", opts.model);
  if (opts.resume) argv.push("-s", opts.resume);
  return argv;
}

export interface OpenCodeSessionOpts {
  cwd: string;
  /** Model for the next spawn (null = CLI default). */
  model: string | null;
  /** Session to resume when this session's first turn starts. */
  resumeSessionId?: string | null;
  runner: OpenCodeRunner;
  /** Provider credentials; merged over the host env at spawn time. */
  env: Record<string, string>;
  onSessionClosed?: () => void;
}

export class OpenCodeSession {
  private readonly opts: OpenCodeSessionOpts;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private sessionId: string | null = null;
  private model: string | null;
  private turnState: OpenCodeTurnState | null = null;
  private running = false;
  private closed = false;
  private startedAt = 0;
  private current: OpenCodeRun | null = null;

  constructor(opts: OpenCodeSessionOpts) {
    this.opts = opts;
    this.model = opts.model;
    this.sessionId = opts.resumeSessionId ?? null;
  }

  // -- lifecycle ------------------------------------------------------------

  async send(text: string): Promise<void> {
    if (this.closed) throw new Error("opencode session closed");
    if (this.running) throw new Error("turn already running on this session");

    this.running = true;
    this.startedAt = Date.now();
    const state = newOpenCodeTurnState({ model: this.model, startedAt: this.startedAt });
    // The resume id is the session this conversation has seen; the FIRST turn
    // may instead resume the id the conversation row remembered.
    state.sessionId = this.sessionId;
    this.turnState = state;

    const argv = buildOpenCodeArgv({
      cwd: this.opts.cwd,
      model: this.model,
      resume: state.sessionId,
    });

    let run: OpenCodeRun;
    try {
      run = this.opts.runner(argv, {
        // Credentials are layered over the host env: the CLI still needs
        // PATH/HOME, and it must never inherit a variable we did not choose
        // to give it in place of one we did. PWD is forced to the workspace:
        // an inherited PWD would point the CLI at the server's own directory
        // instead of the conversation's.
        env: {
          ...(process.env as Record<string, string>),
          ...this.opts.env,
          PWD: this.opts.cwd,
        },
        cwd: this.opts.cwd,
        input: text,
        kill: () => this.current?.kill(),
      });
    } catch (err) {
      this.failRunningTurn(`opencode failed to start: ${messageOf(err)}`);
      return; // accepted-then-failed, matching the contract's "not complete"
    }
    this.current = run;
    this.pump(run, state);
  }

  async interrupt(): Promise<void> {
    if (!this.running) return;
    // Arm the once-guard first: the killed process's stream may still deliver
    // a frame, and the synthetic turn_end below is the authoritative one.
    if (this.turnState) this.turnState.emittedTurnEnd = true;
    this.running = false;
    this.emit({
      type: "turn_end",
      reason: "interrupted",
      model: this.model,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      costUsd: null,
      tokens: { input: null, output: null },
      error: null,
    });
    try {
      this.current?.kill();
    } catch {
      // the process is already gone; Stop has still done its job
    }
  }

  /** Applies to the NEXT spawn — a running process's argv cannot change. */
  async setModel(model?: string): Promise<void> {
    this.model = model ?? null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The OpenCode session id — the resume target stored on the row. */
  cliSessionId(): string | null {
    return this.sessionId;
  }

  onEvent(cb: (event: TurnEvent) => void): void {
    this.listeners.add(cb);
  }

  offEvent(cb: (event: TurnEvent) => void): void {
    this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.listeners.clear();
    try {
      this.opts.onSessionClosed?.();
    } catch {
      // teardown must complete even if the callback misbehaves
    }
    try {
      this.current?.kill();
    } catch {
      // already-dead process
    }
    this.current = null;
  }

  // -- pump -----------------------------------------------------------------

  private pump(run: OpenCodeRun, state: OpenCodeTurnState): void {
    void (async () => {
      try {
        for await (const raw of run.events) {
          if (this.closed) break;
          const events = mapOpenCodeEvent(raw, state);
          if (state.sessionId) this.sessionId = state.sessionId;
          for (const event of events) {
            if (event.type === "turn_end") this.running = false;
            this.emit(event);
          }
          if (!this.running) break;
        }
        // A clean exit is the normal end of a turn here: OpenCode has no
        // terminal frame of its own (step_finish ends a step, not the turn),
        // and a non-zero exit surfaces as a thrown stream from the runner.
        if (this.running && !this.closed) {
          for (const event of finishOpenCodeTurn(state, "done", null)) {
            this.running = false;
            this.emit(event);
          }
        }
      } catch (err) {
        if (this.running && !this.closed) {
          this.failRunningTurn(`opencode stream error: ${messageOf(err)}`);
        }
      } finally {
        if (this.current === run) this.current = null;
      }
    })();
  }

  private failRunningTurn(message: string): void {
    this.running = false;
    const state = this.turnState;
    if (!state) {
      // No turn state to finish from (should not happen); still end the turn.
      this.emit({
        type: "turn_end",
        reason: "error",
        model: this.model,
        durationMs: Math.max(0, Date.now() - this.startedAt),
        costUsd: null,
        tokens: { input: null, output: null },
        error: message,
      });
      return;
    }
    for (const event of finishOpenCodeTurn(state, "error", message)) this.emit(event);
  }

  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // a listener error must never break the pump
      }
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
