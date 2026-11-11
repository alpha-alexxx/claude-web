import type { PermissionAnswer } from "../types";

/**
 * Pending interactive permission requests — the answer path for Allow / Deny
 * cards.
 *
 * The CLI calls a tool and blocks inside `canUseTool` until the browser
 * answers the card that was emitted on the turn's SSE stream. This broker is
 * the in-process meeting point: `request()` is called by the permission
 * handler and suspends; `resolve()` is called by
 * `POST /api/permissions/[requestId]` when the user clicks.
 *
 * Invariants (all ledgered):
 * - fail closed — timeout, session eviction, and unknown state all DENY. A
 *   lost answer must never become an implicit approval.
 * - user-scoped — a requestId is only answerable by the user who owns the
 *   session, and only once. The card is a privileged control over a live
 *   agent process, not a public key.
 * - per-session allowlist — "Allow for session" is keyed
 *   `${userId}:${conversationId}` and lives in memory only: eviction or a
 *   server restart forgets it, so a resumed conversation asks again.
 * - never rejects — a rejected promise would surface as an unhandled
 *   rejection inside the SDK's gate; a deny answer is the only failure mode.
 */

export type PermissionDecision = "allow" | "deny" | "allow_session";

export interface PendingPermissionRequest {
  userId: string;
  /** Pool key (`userId:conversationId`) — the allowlist's scope. */
  sessionKey: string;
  conversationId: string;
  /** CLI-provided request id; the card's button target. */
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type ResolveResult =
  | { ok: true; decision: Exclude<PermissionDecision, "allow_session"> }
  | { ok: false; code: "not_found" };

interface Entry {
  req: PendingPermissionRequest;
  settle: (answer: PermissionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionBrokerOpts {
  /** How long the CLI waits for a click. The SDK's own gate is 5 min. */
  timeoutMs: number;
}

const DENY_TIMEOUT: PermissionAnswer = {
  behavior: "deny",
  message: "Permission request timed out",
};
const DENY_SESSION_CLOSED: PermissionAnswer = {
  behavior: "deny",
  message: "Session closed before the request was answered",
};

export class PermissionBroker {
  private readonly pending = new Map<string, Entry>();
  /** sessionKey → tool names pre-approved for that conversation. */
  private readonly allowed = new Map<string, Set<string>>();
  /** sessionKey → requestIds, so eviction can deny exactly its own. */
  private readonly bySession = new Map<string, Set<string>>();

  constructor(private readonly opts: PermissionBrokerOpts) {
    if (opts.timeoutMs < 1) throw new Error("permission timeout must be >= 1ms");
  }

  /**
   * Register a request and wait for the answer. Resolves to a deny on timeout
   * or session teardown; it never rejects.
   */
  request(req: PendingPermissionRequest): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve) => {
      const settle = (answer: PermissionAnswer) => {
        this.remove(req.requestId);
        resolve(answer);
      };
      const timer = setTimeout(() => settle(DENY_TIMEOUT), this.opts.timeoutMs);
      // Node keeps the process alive for pending timers; a pending permission
      // must not pin the server open during shutdown.
      timer.unref?.();
      this.pending.set(req.requestId, { req, settle, timer });
      let ids = this.bySession.get(req.sessionKey);
      if (!ids) {
        ids = new Set();
        this.bySession.set(req.sessionKey, ids);
      }
      ids.add(req.requestId);
    });
  }

  /**
   * Answer a pending request. `userId` must own it; the same request can be
   * answered exactly once (a double-click is a no-op, not a second answer).
   */
  resolve(
    userId: string,
    requestId: string,
    decision: PermissionDecision,
  ): ResolveResult {
    const entry = this.pending.get(requestId);
    if (!entry || entry.req.userId !== userId) {
      return { ok: false, code: "not_found" };
    }
    if (decision === "allow_session") {
      let set = this.allowed.get(entry.req.sessionKey);
      if (!set) {
        set = new Set();
        this.allowed.set(entry.req.sessionKey, set);
      }
      set.add(entry.req.toolName);
    }
    entry.settle({ behavior: decision === "deny" ? "deny" : "allow" });
    return {
      ok: true,
      decision: decision === "deny" ? "deny" : "allow",
    };
  }

  /** True when this tool was pre-approved for that conversation. */
  isToolAllowed(sessionKey: string, toolName: string): boolean {
    return this.allowed.get(sessionKey)?.has(toolName) ?? false;
  }

  /**
   * Drop everything belonging to a session (pool eviction / close): its
   * pending requests are denied and its allowlist is forgotten.
   */
  forgetSession(sessionKey: string): void {
    const ids = this.bySession.get(sessionKey);
    if (ids) {
      for (const requestId of [...ids]) {
        this.pending.get(requestId)?.settle(DENY_SESSION_CLOSED);
      }
      this.bySession.delete(sessionKey);
    }
    this.allowed.delete(sessionKey);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private remove(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const ids = this.bySession.get(entry.req.sessionKey);
    ids?.delete(requestId);
    if (ids && ids.size === 0) this.bySession.delete(entry.req.sessionKey);
  }
}
