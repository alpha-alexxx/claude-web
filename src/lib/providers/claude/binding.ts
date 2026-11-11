import type { DatabaseSync } from "node:sqlite";
import type {
  ActiveSession,
  PermissionAnswer,
  PermissionHandler,
  TurnEvent,
} from "../types";
import type { PermissionBroker } from "./permissions";
import {
  recordToolDecision,
  recordToolRequest,
  recordToolResult,
} from "../../db/tool-calls-repo";

/**
 * Session binding — turns one (user, conversation) pair into the hooks the
 * session pool needs, and adds the audit trail that rides the same session.
 *
 * Every hook is a PURE FUNCTION OF THE SESSION KEY. The pool binds them at
 * session creation and never re-reads them (`pool.get()` ignores options for
 * an existing session), so anything captured here lives as long as the CLI
 * process does. Two consequences the call sites must respect:
 *   - the route builds a fresh binding per request, from the same key, and a
 *     reused session simply keeps the equivalent one built at creation;
 *   - nothing per-turn (the user's text, a model choice) may be captured.
 *
 * Audit trail (plan Phase 4: "Inputs recorded in tool_calls before decision,
 * audit shows denials"):
 *   ask      → pending row           (recordToolRequest)
 *   answer   → allowed / denied      (recordToolDecision)
 *   result   → ok / error + output   (recordToolResult, session-lifetime
 *                                     listener, attached once per session)
 *
 * The audit is a RECORD, NOT A GATE: a failed write is logged and swallowed.
 * Failing closed on a storage error would deny a tool the user explicitly
 * approved, and the approval is the authoritative fact here.
 */

export interface SessionBindingOpts {
  userId: string;
  /** Pool key AND the conversations PK (`userId:clientConversationId`). */
  sessionKey: string;
  /** Conversation the audit rows belong to (same as sessionKey). */
  conversationId: string;
  db: DatabaseSync;
  broker: PermissionBroker;
}

export interface SessionBinding {
  onPermission: PermissionHandler;
  isToolAllowed: (toolName: string) => boolean;
  onSessionClosed: () => void;
  /**
   * Attach the session-lifetime audit listener. Must be called on the
   * session object returned for this key; safe to call again for a reused
   * session (each live session gets exactly one listener).
   */
  attach(session: Pick<ActiveSession, "onEvent">): void;
}

/**
 * Live sessions that already carry an audit listener. A WeakSet keyed on the
 * session object is what makes re-attachment safe: the pool hands back the
 * same object on reuse, so a second turn cannot stack a second listener —
 * which would double every audit write for the life of the process (and the
 * leak would survive every turn after it).
 */
let attached = new WeakSet<object>();

/**
 * Test seam: forget which sessions were instrumented.
 *
 * Replacing the WeakSet (not just the countable mirror) is required — a
 * test's fake session object can outlive the test that first attached to it,
 * and a stale entry would silently skip the new listener.
 */
export function resetSessionBindingForTest(): void {
  attached = new WeakSet<object>();
  listenersForTest.clear();
}

/** Test seam: how many live sessions currently carry a listener. */
export function attachedSessionCountForTest(): number {
  return listenersForTest.size;
}

/** Mirrors `attached` (a WeakSet is not countable), cleared with it. */
const listenersForTest = new Set<object>();

function audit(action: string, err: unknown): void {
  // Never throw from the audit path; a record that cannot be written must
  // not change what the user was allowed to do.
  console.error(
    `[tool_calls audit] ${action} failed:`,
    err instanceof Error ? err.message : String(err),
  );
}

export function createSessionBinding(opts: SessionBindingOpts): SessionBinding {
  const { userId, sessionKey, conversationId, db, broker } = opts;

  const onPermission: PermissionHandler = async (req) => {
    const { requestId, toolUseId, toolName, input } = req;

    // Record the ASK first, synchronously, before the promise yields: the
    // call is on the audit even if the browser never answers.
    try {
      recordToolRequest(db, { conversationId, toolUseId, name: toolName, input });
    } catch (err) {
      audit("request", err);
    }

    // Never rejects: timeout, eviction, and unknown state all settle to deny.
    const answer = await broker.request({
      userId,
      sessionKey,
      conversationId,
      requestId,
      toolUseId,
      toolName,
      input,
    });
    const decided: PermissionAnswer = answer;

    try {
      recordToolDecision(db, {
        conversationId,
        toolUseId,
        name: toolName,
        input,
        decision: decided.behavior,
        decidedBy: userId,
      });
    } catch (err) {
      audit("decision", err);
    }

    return decided;
  };

  return {
    onPermission,
    isToolAllowed: (toolName) => broker.isToolAllowed(sessionKey, toolName),
    // Eviction / close / shutdown: deny prompts nobody can answer any more
    // and forget the allow-for-session list with the session.
    onSessionClosed: () => broker.forgetSession(sessionKey),

    attach(session) {
      const key = session as unknown as object;
      if (attached.has(key)) return;
      attached.add(key);
      listenersForTest.add(key);
      session.onEvent((event: TurnEvent) => {
        // Only results are audited here; the ask and the decision are written
        // by onPermission, which is where the gate actually lives.
        if (event.type !== "tool_end") return;
        try {
          recordToolResult(db, {
            conversationId,
            toolUseId: event.id,
            ok: event.ok,
            output: event.output,
          });
        } catch (err) {
          audit("result", err);
        }
      });
    },
  };
}
