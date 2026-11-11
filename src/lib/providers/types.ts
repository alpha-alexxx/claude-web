/**
 * Provider adapter seam — the single contract every coding-agent CLI
 * backend implements. The UI consumes only `TurnEvent`s and capability
 * flags; per-provider `if`s in components are a design failure.
 *
 * v1 ships the Claude adapter complete. Codex/OpenCode/Qoder land
 * incrementally behind this same interface (see the plan's adapter build
 * order), so the shapes below are deliberately provider-neutral: no Claude
 * vocabulary beyond what maps 1:1 onto the neutral event stream.
 */

/**
 * Appended by any adapter that caps tool output. Part of the contract, not an
 * adapter detail: the UI checks for it to say "truncated" instead of showing a
 * clipped result as if it were complete. Adapters that produce their own
 * markers should use this exact string.
 */
export const OUTPUT_TRUNCATION_MARK = "\n… [output truncated]";

/** Neutral turn event stream — same vocabulary as the legacy SSE contract. */
export type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_start";
      id: string;
      name: string;
      summary: string;
      input: Record<string, unknown>;
      /** Non-null when a subagent (parent tool_use) produced the call. */
      parentToolUseId: string | null;
    }
  | { type: "tool_end"; id: string; ok: boolean; output: string }
  | {
      type: "permission_request";
      requestId: string;
      toolName: string;
      toolUseId: string;
      input: Record<string, unknown>;
      /** e.g. "Bash(npm install)" — provider-rendered display hint. */
      displayHint: string | null;
    }
  | {
      type: "turn_end";
      reason: "done" | "error" | "interrupted";
      model: string | null;
      durationMs: number;
      costUsd: number | null;
      tokens: { input: number | null; output: number | null };
      error: string | null;
    };

export interface ProviderCapabilities {
  /** Per-call interactive Allow/Deny — only Claude documents one today. */
  interactiveToolPrompts: boolean;
  sessionResume: boolean;
  partialText: boolean;
  skills: "native" | "symlink" | "managed";
  plugins: boolean;
}

export interface ProviderInventory {
  id: ProviderId;
  installed: boolean;
  /** Resolved version string, or null when not installed. */
  version: string | null;
  /**
   * Tri-state auth: true/false from a verified credential source; null =
   * unknown until a live session reports (SDK-bundled CLIs have no probe
   * cheaper than starting one).
   */
  authed: boolean | null;
  /** Why the provider is unavailable, when it is (missing step named). */
  reason: string | null;
  models: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  label: string | null;
}

export interface SessionOpts {
  /** Pool key: user-scoped composite (`userId:conversationId`) so two users
   * can never steer each other's sessions. */
  conversationId: string;
  /** Per-conversation working directory (already containment-checked). */
  cwd: string;
  model: string | null;
  /** Resume a CLI-own session id when reopening a conversation. */
  resumeSessionId?: string | null;
  /** Resolves an interactive permission request; null = deny (fail closed). */
  onPermission?: PermissionHandler;
  /**
   * "Allow for session" — tools already approved for this conversation.
   * Consulted before the permission card, so a hit is silent.
   */
  isToolAllowed?: (toolName: string) => boolean;
  /**
   * Called when the session goes away (LRU eviction, close, server shutdown)
   * so the caller can deny prompts that can no longer be answered.
   *
   * NOTE for adapter authors: like every option here, these take effect on
   * session CREATION. A reused session keeps the hooks it was born with —
   * they must be pure functions of the session key, never of one turn.
   */
  onSessionClosed?: () => void;
}

/** One pending interactive prompt, as the adapter surfaces it upward. */
export interface PermissionRequest {
  /** Stable id the browser posts back; the card's button target. */
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface PermissionAnswer {
  behavior: "allow" | "deny";
  message?: string;
}

/**
 * The interactive gate. Receives the whole request (not just name+input) so
 * the answer path can correlate a browser click with this exact CLI call.
 * Returning null denies.
 */
export type PermissionHandler = (
  request: PermissionRequest,
) => Promise<PermissionAnswer | null>;

export type ProviderId = "claude" | "codex" | "opencode" | "qoder";

/**
 * The seam. `startSession` is the long-lived pattern: it returns an active
 * session bound to one conversation, supporting multiple turns without a
 * process respawn where the CLI allows it.
 */
export interface ProviderAdapter {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  inventory(): Promise<ProviderInventory>;
  startsSession(opts: SessionOpts): ActiveSession | Promise<ActiveSession>;
  /**
   * Peek a live session WITHOUT creating one (Stop button, live re-attach).
   * Null when no session exists for the key. Absent = provider lacks a
   * pool and cannot peek.
   */
  liveSession?(conversationId: string): ActiveSession | null;
}

export interface ActiveSession {
  /** Send one user turn. Resolves when accepted, not when complete. */
  send(text: string): Promise<void>;
  /**
   * Switch the model for subsequent turns ("auto"/undefined = CLI default).
   * Only exists where the CLI's session is live and mutable (streaming
   * input mode); absent = mid-session switches unsupported (send the
   * choice with the next turn instead).
   */
  setModel?(model?: string): Promise<void>;
  /** Stop the in-flight turn (Stop button). */
  interrupt(): Promise<void>;
  /** Stream-subscribe raw turn events. */
  onEvent(cb: (event: TurnEvent) => void): void;
  /** Detach a listener (SSE disconnect) — without this, reconnects leak. */
  offEvent(cb: (event: TurnEvent) => void): void;
  /** Close the session and its child process, if any. */
  close(): Promise<void>;
}
