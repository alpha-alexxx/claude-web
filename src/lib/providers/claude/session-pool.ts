import {
  query as createSdkQuery,
  type CanUseTool,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  mapSdkMessage,
  newTurnState,
  toolSummary,
  type TurnState,
} from "./message-mapper";
import type { PermissionHandler, TurnEvent } from "../types";

/**
 * One `query()` per active conversation, with an AsyncIterable prompt — the
 * SDK's hosted multi-turn pattern. Streaming input mode is what makes
 * `interrupt()` (Stop button) and `setModel()` (model picker) legal; a
 * per-turn respawn would forfeit both.
 *
 * The pool caps live conversations (each ≈1 GiB RAM): idle sessions evict
 * LRU, a running turn is NEVER killed — a cap-full all-busy pool rejects
 * new gets instead, so an in-flight turn can't be destroyed by traffic.
 */

/** The injectable seam: tests script this; production uses the real SDK. */
export type QueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface PoolGetOpts {
  cwd: string;
  model: string | null;
  /** CLI session id to resume (reopening a conversation). */
  resumeSessionId?: string | null;
  /** Interactive Allow/Deny gate; null/absent = deny (fail closed). */
  onPermission?: PermissionHandler;
  /**
   * Pre-approved tools for this conversation (the broker's allowlist). A hit
   * skips the card AND the handler — emitted before canUseTool is entered.
   */
  isToolAllowed?: (toolName: string) => boolean;
  /** Session going away (eviction, close): deny pending prompts, forget allowlist. */
  onSessionClosed?: () => void;
}

export interface PoolSession {
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  /** True while a turn is in flight. */
  isRunning(): boolean;
  /** CLI-side session id once known (resume target, conversation row). */
  cliSessionId(): string | null;
  /** Credential source reported by the CLI (health check). */
  apiKeySource(): string | null;
  /** CLI version from the init frame (health check). */
  cliVersion(): string | null;
  onEvent(cb: (event: TurnEvent) => void): void;
  /** Detach a listener (SSE disconnect). */
  offEvent(cb: (event: TurnEvent) => void): void;
  close(): Promise<void>;
}

/** Push-only async iterable the SDK consumes as the prompt stream. */
class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(msg: SDKUserMessage): void {
    if (this.ended) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value: msg, done: false });
    else this.queue.push(msg);
  }

  end(): void {
    this.ended = true;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    // this is both iterable and iterator (the SDK consumes it in one pass)
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    if (this.ended) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

class PoolSessionImpl implements PoolSession {
  readonly query: Query;
  private readonly channel = new PromptChannel();
  private readonly listeners = new Set<(e: TurnEvent) => void>();
  private readonly getOpts: PoolGetOpts;
  private readonly onDetached: () => void;
  private turnState: TurnState = newTurnState({ partial: true });
  private running = false;
  private startedAt = 0;
  private cliSess: string | null = null;
  private authSource: string | null = null;
  private cliVer: string | null = null;
  private dead = false;
  private closed = false;

  constructor(
    private readonly factory: QueryFactory,
    getOpts: PoolGetOpts,
    onDetached: () => void,
  ) {
    this.getOpts = getOpts;
    this.onDetached = onDetached;

    const options: Options = {
      cwd: getOpts.cwd,
      // Ledger ruling: explicit, never inherited — the operator's default
      // sources inherit plugin hooks costing ~60 s of startup per turn.
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      permissionMode: "default",
      permissionPrompts: "host",
      canUseTool: this.handleCanUseTool,
      ...(getOpts.model ? { model: getOpts.model } : {}),
      ...(getOpts.resumeSessionId ? { resume: getOpts.resumeSessionId } : {}),
    };
    this.query = factory({ prompt: this.channel, options });
    this.pump();
  }

  // -- lifecycle ------------------------------------------------------------

  send(text: string): Promise<void> {
    if (this.dead || this.closed) {
      return Promise.reject(new Error("session closed or unavailable"));
    }
    if (this.running) {
      return Promise.reject(new Error("turn already running on this session"));
    }
    // Fresh per-turn mapper state: new tool ids, fresh turn_end once-guard.
    this.turnState = newTurnState({ partial: true });
    this.running = true;
    this.startedAt = Date.now();
    this.channel.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
    return Promise.resolve(); // accepted, not complete (contract)
  }

  async interrupt(): Promise<void> {
    if (!this.running || this.dead || this.closed) return;
    // Arm the once-guard FIRST: the CLI answers interrupts with a belated
    // error-during-execution result frame, which must map to zero events —
    // the synthetic turn_end below is the single authoritative end of turn.
    this.turnState.emittedTurnEnd = true;
    this.running = false;
    this.emit({
      type: "turn_end",
      reason: "interrupted",
      model: this.turnState.model,
      durationMs: Date.now() - this.startedAt,
      costUsd: null,
      tokens: { input: null, output: null },
      error: null,
    });
    await this.query.interrupt();
  }

  async setModel(model?: string): Promise<void> {
    await this.query.setModel(model);
  }

  isRunning(): boolean {
    return this.running;
  }

  cliSessionId(): string | null {
    return this.cliSess;
  }

  apiKeySource(): string | null {
    return this.authSource;
  }

  cliVersion(): string | null {
    return this.cliVer;
  }

  onEvent(cb: (event: TurnEvent) => void): void {
    this.listeners.add(cb);
  }

  offEvent(cb: (event: TurnEvent) => void): void {
    this.listeners.delete(cb);
  }

  async close(): Promise<void> {
    this.detach();
  }

  /** Synchronous teardown used by eviction and close(). */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.listeners.clear();
    // Notify the owner BEFORE the process dies: pending permission prompts
    // must be denied and the session's allowlist forgotten, or a card whose
    // turn is gone would stay answerable until its timeout.
    try {
      this.getOpts.onSessionClosed?.();
    } catch {
      // teardown must complete even if the callback misbehaves
    }
    this.channel.end();
    this.onDetached();
    try {
      this.query.close();
    } catch {
      // already-dead CLI — closing must never throw
    }
  }

  // -- event pump -----------------------------------------------------------

  private emit(event: TurnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // a listener error must never break the pump
      }
    }
  }

  private pump(): void {
    void (async () => {
      try {
        for await (const raw of this.query) {
          this.handleFrame(raw);
        }
        if (this.running && !this.closed) {
          // The generator ended without a result frame: the CLI process died.
          this.failRunningTurn("claude process ended unexpectedly");
        }
      } catch (err) {
        if (this.running && !this.closed) {
          this.failRunningTurn(
            `claude stream error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        if (this.running && !this.closed) {
          this.failRunningTurn("claude stream closed");
        }
        this.dead = true;
      }
    })();
  }

  private failRunningTurn(message: string): void {
    this.running = false;
    this.emit({
      type: "turn_end",
      reason: "error",
      model: this.turnState.model,
      durationMs: Date.now() - this.startedAt,
      costUsd: null,
      tokens: { input: null, output: null },
      error: message,
    });
  }

  private handleFrame(raw: unknown): void {
    const rec =
      typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    if (!rec) return;
    if (this.cliSess === null && typeof rec["session_id"] === "string") {
      this.cliSess = rec["session_id"] as string;
    }
    if (this.authSource === null && typeof rec["apiKeySource"] === "string") {
      this.authSource = rec["apiKeySource"] as string;
    }
    if (this.cliVer === null && typeof rec["claude_code_version"] === "string") {
      this.cliVer = rec["claude_code_version"] as string;
    }
    const events = mapSdkMessage(raw, this.turnState);
    for (const event of events) {
      if (event.type === "turn_end" && !this.closed && this.running) {
        this.running = false;
      }
      this.emit(event);
    }
  }

  // -- interactive permissions ------------------------------------------------

  /**
   * canUseTool (fail closed): a tool pre-approved for the session is allowed
   * silently; everything else emits a permission_request card and awaits the
   * conversation's answer. No handler / null / throw → deny.
   */
  private readonly handleCanUseTool: CanUseTool = async (toolName, input, opts) => {
    const requestId = typeof opts.requestId === "string" ? opts.requestId : "";
    const toolUseId = opts.toolUseID ?? "";
    if (this.getOpts.isToolAllowed?.(toolName)) {
      // No card, no round trip: "Allow for session" already answered this.
      return { behavior: "allow" as const, updatedInput: input, toolUseID: toolUseId };
    }
    this.emit({
      type: "permission_request",
      requestId,
      toolName,
      toolUseId,
      input,
      displayHint: `${toolName}(${toolSummaryLabel(toolName, input)})`,
    });
    try {
      // The handler registers the request with the broker BEFORE the card can
      // be clicked (emit above is synchronous; the click needs a round trip),
      // so the requestId is always answerable by the time the browser has it.
      const answer =
        (await this.getOpts.onPermission?.({
          requestId,
          toolUseId,
          toolName,
          input,
        })) ?? null;
      if (answer && answer.behavior === "allow") {
        return {
          behavior: "allow" as const,
          updatedInput: input,
          toolUseID: toolUseId,
        };
      }
      const message =
        answer && answer.behavior === "deny" && answer.message
          ? answer.message
          : "No permission surface answered this request";
      return {
        behavior: "deny" as const,
        message,
        interrupt: false,
        toolUseID: toolUseId,
      };
    } catch (err) {
      return {
        behavior: "deny" as const,
        message: `Permission check failed: ${err instanceof Error ? err.message : String(err)}`,
        interrupt: false,
        toolUseID: toolUseId,
      };
    }
  };
}

/** Short human label for the permission card header. */
function toolSummaryLabel(toolName: string, input: Record<string, unknown>): string {
  const summary = toolSummary(toolName, input);
  return summary === "" ? "…" : summary;
}

// -- the pool ---------------------------------------------------------------

export class ClaudeSessionPool {
  private readonly sessions = new Map<string, PoolSessionImpl>();
  private readonly cap: number;

  constructor(
    private readonly factory: QueryFactory = createSdkQuery,
    cap: number,
  ) {
    if (cap < 1) throw new Error("session pool cap must be >= 1");
    this.cap = cap;
  }

  /** Get or create the session for a conversation; LRU-evicts idle ones. */
  get(convId: string, opts: PoolGetOpts): PoolSession {
    const existing = this.sessions.get(convId);
    if (existing) {
      // LRU bump: move to freshest position (Map preserves insertion order).
      this.sessions.delete(convId);
      this.sessions.set(convId, existing);
      return existing;
    }
    while (this.sessions.size >= this.cap) {
      let victim: string | null = null;
      for (const [id, s] of this.sessions) {
        if (!s.isRunning()) {
          victim = id;
          break;
        }
      }
      if (victim === null) {
        throw new Error("session pool at capacity: every session is mid-turn");
      }
      const evicted = this.sessions.get(victim);
      this.sessions.delete(victim);
      evicted?.detach();
    }
    const session = new PoolSessionImpl(this.factory, opts, () =>
      this.sessions.delete(convId),
    );
    this.sessions.set(convId, session);
    return session;
  }

  /**
   * Peek at a live session without creating or LRU-bumping one. Returns null
   * when the conversation has no session in the pool.
   */
  getIfLive(convId: string): PoolSession | null {
    return this.sessions.get(convId) ?? null;
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Aggregate over live sessions for the health check: any session that has
   * reported its init frame contributes the credential source and CLI
   * version (identical across sessions of one CLI install).
   */
  health(): { active: number; apiKeySource: string | null; cliVersion: string | null } {
    let apiKeySource: string | null = null;
    let cliVersion: string | null = null;
    for (const s of this.sessions.values()) {
      apiKeySource = apiKeySource ?? s.apiKeySource();
      cliVersion = cliVersion ?? s.cliVersion();
    }
    return { active: this.sessions.size, apiKeySource, cliVersion };
  }

  /** Close every session (tests and graceful shutdown). */
  async closeAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) s.detach();
    this.sessions.clear();
  }
}
