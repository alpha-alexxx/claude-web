import { finishQoderTurn, mapQoderFrame, newQoderTurnState, type QoderTurnState } from "./message-mapper";
import type { TurnEvent } from "../types";

/**
 * One `qoder --print` process per TURN.
 *
 * Qoder's headless transport is Claude's stream-json dialect, but the shape of
 * the process is Codex/OpenCode's: it takes the prompt on stdin, streams
 * NDJSON, and exits when the turn is over. Continuity comes from the session
 * id echoed on every frame (`--resume <id>` on the next turn), not from a
 * long-lived process. So:
 *
 *   - at most ONE in-flight process per conversation; `send()` rejects while
 *     it runs (the route serialises turns anyway);
 *   - `interrupt()` kills the process — the only way to stop it;
 *   - `setModel()` stores the choice for the NEXT spawn;
 *   - the session object outlives its processes; the session id and the
 *     listener set are the state that survives.
 */

/** Options handed to a runner for one turn. */
export interface QoderRunOpts {
  /** Environment for the child: host env plus provider credentials. */
  env: Record<string, string>;
  /** Working directory (already contained by the chat route). */
  cwd: string;
  /** The user's prompt, written to the child's stdin. */
  input: string;
  /** Ends the turn's stream (timeout / Stop). */
  kill: () => void;
}

/** Streamed NDJSON frames from one `qoder` invocation. */
export interface QoderRun {
  events: AsyncIterable<unknown>;
  /** SIGTERM the process (and its group); the pump sees the stream end. */
  kill: () => void;
}

export type QoderRunner = (argv: string[], opts: QoderRunOpts) => QoderRun;

/**
 * RULED flags, not user-configurable yet.
 *
 *   --print                       — headless: one prompt in, one stream out,
 *                                   then exit.
 *   --output-format stream-json   — the machine-readable dialect the mapper
 *                                   reads. Also makes the CLI ignore any
 *                                   non-JSON chatter it would otherwise print.
 *   --include-partial-messages    — REQUIRED for `stream_event` frames to be
 *                                   emitted at all. Without it the UI shows
 *                                   nothing until each block completes.
 *   --permission-mode
 *     bypass_permissions          — the only headless mode that runs tools.
 *                                   `dont_ask` denies every request and `auto`
 *                                   needs a classifier plus a circuit breaker,
 *                                   so both fail a coding turn unattended.
 *   --cwd <dir>                   — the CLI's own directory flag, so the
 *                                   workspace reaches it twice: here and as
 *                                   the spawn cwd.
 *   -m <model>                    — omitted for the "auto" sentinel.
 *   --resume <id>                 — only when a session id is known.
 *
 * The prompt is NOT placed on argv. argv is world-readable in the process
 * table, and Qoder reads a full prompt from stdin when no positional is given
 * (with an 8 MiB cap, far past any chat message).
 *
 * `--permission-prompt-tool` is deliberately absent: it is not a declared
 * option in qodercli 1.1.86 — it exists only inside the CLI's internal
 * option-swallowing set, so passing it would depend on unknown-option
 * tolerance and could silently break on the next patch release. That is why
 * the adapter advertises `interactiveToolPrompts: false`.
 */
export function buildQoderArgv(opts: { cwd: string; model: string | null; resume: string | null }): string[] {
  const argv = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-mode",
    "bypass_permissions",
    "--cwd",
    opts.cwd,
  ];
  if (opts.model) argv.push("-m", opts.model);
  if (opts.resume) argv.push("--resume", opts.resume);
  return argv;
}

export interface QoderSessionOpts {
  cwd: string;
  /** Model for the next spawn (null = CLI default). */
  model: string | null;
  /** Session to resume when this session's first turn starts. */
  resumeSessionId?: string | null;
  runner: QoderRunner;
  /** Provider credentials; merged over the host env at spawn time. */
  env: Record<string, string>;
  onSessionClosed?: () => void;
}

export class QoderSession {
  private readonly opts: QoderSessionOpts;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private sessionId: string | null = null;
  private model: string | null;
  private turnState: QoderTurnState | null = null;
  private running = false;
  private closed = false;
  private startedAt = 0;
  private current: QoderRun | null = null;

  constructor(opts: QoderSessionOpts) {
    this.opts = opts;
    this.model = opts.model;
    this.sessionId = opts.resumeSessionId ?? null;
  }

  // -- lifecycle ------------------------------------------------------------

  async send(text: string): Promise<void> {
    if (this.closed) throw new Error("qoder session closed");
    if (this.running) throw new Error("turn already running on this session");

    this.running = true;
    this.startedAt = Date.now();
    const state = newQoderTurnState({ model: this.model, startedAt: this.startedAt });
    // The resume id is the session this conversation has seen; the FIRST turn
    // may instead resume the id the conversation row remembered.
    state.sessionId = this.sessionId;
    this.turnState = state;

    const argv = buildQoderArgv({ cwd: this.opts.cwd, model: this.model, resume: state.sessionId });

    let run: QoderRun;
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
      this.failRunningTurn(`qoder failed to start: ${messageOf(err)}`);
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

  /** The Qoder session id — the resume target stored on the row. */
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

  private pump(run: QoderRun, state: QoderTurnState): void {
    void (async () => {
      try {
        for await (const raw of run.events) {
          if (this.closed) break;
          const events = mapQoderFrame(raw, state);
          if (state.sessionId) this.sessionId = state.sessionId;
          for (const event of events) {
            if (event.type === "turn_end") this.running = false;
            this.emit(event);
          }
          if (!this.running) break;
        }
        // The `result` frame normally ends the turn; a stream that stops
        // without one (a version that drops the frame, a SIGTERM we did not
        // send) still exits cleanly, and an unfinished turn would leave the
        // composer locked. The once-guard makes this a no-op after a result.
        if (this.running && !this.closed) {
          for (const event of finishQoderTurn(state, "done", null)) {
            this.running = false;
            this.emit(event);
          }
        }
      } catch (err) {
        if (this.running && !this.closed) {
          this.failRunningTurn(`qoder stream error: ${messageOf(err)}`);
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
    for (const event of finishQoderTurn(state, "error", message)) this.emit(event);
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
