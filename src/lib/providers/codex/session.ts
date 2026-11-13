import { mapThreadEvent, newCodexTurnState, type CodexTurnState } from "./message-mapper";
import type { TurnEvent } from "../types";

/**
 * One `codex exec` process per TURN.
 *
 * Unlike Claude's SDK, Codex has no streaming-input mode: `codex exec` takes
 * the prompt on stdin, streams JSONL on stdout and exits when the turn is
 * over. Conversation continuity therefore comes from the thread id
 * (`thread.started` → `resume <id>` on the next turn), not from a long-lived
 * process. That shapes everything below:
 *
 *   - there is at most ONE in-flight process per conversation, and `send()`
 *     rejects while it runs (the route serialises turns anyway);
 *   - `interrupt()` kills the process — the only way to stop it;
 *   - `setModel()` stores the choice for the NEXT spawn, because the running
 *     process's argv is fixed;
 *   - the session object outlives its processes, so the thread id and the
 *     listener set are the state that persists.
 *
 * The process itself is reached through `CodexRunner`, injected here so the
 * session is testable without a CLI on the host.
 */

/** Options handed to a runner for one turn. */
export interface CodexRunOpts {
  /** Environment for the child: host env plus provider credentials. */
  env: Record<string, string>;
  /** Working directory (already contained by the chat route). */
  cwd: string;
  /** The user's prompt, written to the child's stdin. */
  input: string;
  /** Ends the turn's stream (timeout / Stop). */
  kill: () => void;
}

/** Streamed JSONL frames from one `codex exec` run. */
export interface CodexRun {
  events: AsyncIterable<unknown>;
  /** SIGTERM the process (and its group); the pump sees the stream end. */
  kill: () => void;
}

export type CodexRunner = (argv: string[], opts: CodexRunOpts) => CodexRun;

/**
 * Sandbox policy. These are RULED defaults, not user-configurable yet:
 *
 *   sandbox workspace-write  — the agent may write inside the conversation's
 *                              workspace and read the host, but cannot touch
 *                              the rest of the filesystem.
 *   approval_policy "never"  — `codex exec` has no way to ask (there is no
 *                              interactive prompt on this transport). A
 *                              policy that WAITS would hang the turn until the
 *                              SSE timeout with no card the user could click,
 *                              so the honest setting is one that never waits.
 *                              The sandbox, not an approval, is the boundary.
 *   network_access true      — a coding agent that cannot fetch a lockfile is
 *                              not useful, and the Claude adapter's own tools
 *                              have unrestricted network. What it may write
 *                              is still bounded by the sandbox above.
 *   skip-git-repo-check      — workspaces need not be git repositories.
 */
export function buildCodexArgv(opts: {
  cwd: string;
  model: string | null;
  resume: string | null;
}): string[] {
  const argv = [
    "exec",
    "--experimental-json",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "--config",
    "sandbox_workspace_write.network_access=true",
    "--cd",
    opts.cwd,
    "--skip-git-repo-check",
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.resume) argv.push("resume", opts.resume);
  return argv;
}

export interface CodexSessionOpts {
  cwd: string;
  /** Model for the next spawn (null = CLI default). */
  model: string | null;
  /** Thread to resume when this session's first turn starts. */
  resumeSessionId?: string | null;
  runner: CodexRunner;
  /** Provider credentials; merged over the host env at spawn time. */
  env: Record<string, string>;
  onSessionClosed?: () => void;
}

export class CodexSession {
  private readonly opts: CodexSessionOpts;
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private threadId: string | null = null;
  private model: string | null;
  private turnState: CodexTurnState | null = null;
  private running = false;
  private closed = false;
  private startedAt = 0;
  private current: CodexRun | null = null;

  constructor(opts: CodexSessionOpts) {
    this.opts = opts;
    this.model = opts.model;
    this.threadId = opts.resumeSessionId ?? null;
  }

  // -- lifecycle ------------------------------------------------------------

  async send(text: string): Promise<void> {
    if (this.closed) throw new Error("codex session closed");
    if (this.running) throw new Error("turn already running on this session");

    this.running = true;
    this.startedAt = Date.now();
    const state = newCodexTurnState({ model: this.model, startedAt: this.startedAt });
    // The resume id is the thread this session has seen; the FIRST turn may
    // instead resume the id the conversation row remembered.
    state.threadId = this.threadId;
    this.turnState = state;

    const argv = buildCodexArgv({
      cwd: this.opts.cwd,
      model: this.model,
      resume: state.threadId,
    });

    let run: CodexRun;
    try {
      run = this.opts.runner(argv, {
        // Credentials are layered over the host env: the CLI still needs
        // PATH/HOME, and it must never inherit a variable we did not choose
        // to give it in place of one we did.
        env: { ...(process.env as Record<string, string>), ...this.opts.env },
        cwd: this.opts.cwd,
        input: text,
        kill: () => this.current?.kill(),
      });
    } catch (err) {
      this.failRunningTurn(`codex failed to start: ${messageOf(err)}`);
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
      durationMs: Date.now() - this.startedAt,
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

  /** The Codex thread id — the resume target stored on the conversation row. */
  cliSessionId(): string | null {
    return this.threadId;
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

  private pump(run: CodexRun, state: CodexTurnState): void {
    void (async () => {
      try {
        for await (const raw of run.events) {
          if (this.closed) break;
          const events = mapThreadEvent(raw, state);
          if (state.threadId) this.threadId = state.threadId;
          for (const event of events) {
            if (event.type === "turn_end") this.running = false;
            this.emit(event);
          }
          if (!this.running) break;
        }
        if (this.running && !this.closed) {
          this.failRunningTurn("codex process ended unexpectedly");
        }
      } catch (err) {
        if (this.running && !this.closed) {
          this.failRunningTurn(`codex stream error: ${messageOf(err)}`);
        }
      } finally {
        if (this.current === run) this.current = null;
      }
    })();
  }

  private failRunningTurn(message: string): void {
    this.running = false;
    this.emit({
      type: "turn_end",
      reason: "error",
      model: this.model,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      costUsd: null,
      tokens: { input: null, output: null },
      error: message,
    });
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
