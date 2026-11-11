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
  /** Pool key: the conversation's own id. */
  conversationId: string;
  /** Per-conversation working directory (already containment-checked). */
  cwd: string;
  model: string | null;
  /** Resume a CLI-own session id when reopening a conversation. */
  resumeSessionId?: string | null;
  /** Server-side event listener for the turn stream. */
  onEvent: (event: TurnEvent) => void;
  /** Resolves an interactive permission request; null = deny. */
  onPermission?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<PermissionAnswer | null>;
}

export interface PermissionAnswer {
  behavior: "allow" | "deny";
  message?: string;
}

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
}

export interface ActiveSession {
  /** Send one user turn. Resolves when accepted, not when complete. */
  send(text: string): Promise<void>;
  /** Stop the in-flight turn (Stop button). */
  interrupt(): Promise<void>;
  /** Stream-subscribe raw turn events. */
  onEvent(cb: (event: TurnEvent) => void): void;
  /** Detach a listener (SSE disconnect) — without this, reconnects leak. */
  offEvent(cb: (event: TurnEvent) => void): void;
  /** Close the session and its child process, if any. */
  close(): Promise<void>;
}
