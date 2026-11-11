import { SseFrameParser } from "./sse";
import { turnErrorEvent, type PermissionDecision } from "./chat-view";
import type { TurnEvent } from "@/lib/providers/types";

export interface RunTurnOptions {
  conversationId: string;
  provider: string;
  cwd: string;
  text: string;
  /** Override model for this turn; omit to keep the session's current one. */
  model?: string;
  /** CLI session to resume (a reopened conversation's cli_session_id). */
  resumeSessionId?: string;
  /** Injectable fetch (tests script this); defaults to the global. */
  fetch?: typeof fetch;
  /** Called with each parsed event, in arrival order. */
  onEvent: (event: TurnEvent) => void;
}

/**
 * Browser transport for one chat turn: POST /api/chat, then stream the SSE
 * response through the frame parser, dispatching events as frames arrive —
 * never buffered to stream end (a turn is minutes long; text must show up
 * while it is being produced).
 *
 * Every failure path collapses to the same shape the server uses: one
 * error turn_end via turnErrorEvent, then resolve. There is exactly one
 * way this promise rejects: never (the reducer treats events, not
 * exceptions) — callers can `void runTurn(...)` and drive UI off onEvent.
 */
export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const body: Record<string, string> = {
    conversationId: opts.conversationId,
    provider: opts.provider,
    cwd: opts.cwd,
    text: opts.text,
  };
  if (opts.model !== undefined) body.model = opts.model;
  if (opts.resumeSessionId !== undefined) {
    body.resumeSessionId = opts.resumeSessionId;
  }

  let response: Response;
  try {
    response = await doFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    opts.onEvent(turnErrorEvent(`network request failed: ${messageOf(err)}`));
    return;
  }

  if (!response.ok) {
    opts.onEvent(turnErrorEvent(await failureMessage(response)));
    return;
  }

  if (!response.body) {
    opts.onEvent(turnErrorEvent("response had no body to stream"));
    return;
  }

  let sawEnd = false;
  const emit = (event: TurnEvent) => {
    opts.onEvent(event);
    if (event.type === "turn_end") sawEnd = true;
  };

  const parser = new SseFrameParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        emit(event);
      }
      if (sawEnd) {
        // turn_end is terminal by contract — stop reading and free the socket.
        void reader.cancel().catch(() => {});
        return;
      }
    }
    for (const event of parser.end()) emit(event);
  } catch (err) {
    opts.onEvent(turnErrorEvent(`stream read failed: ${messageOf(err)}`));
    return;
  }

  // The server always emits turn_end; reaching here means it died silently.
  if (!sawEnd) opts.onEvent(turnErrorEvent("stream ended before the turn did"));
}

export interface AnswerPermissionOptions {
  requestId: string;
  decision: PermissionDecision;
  /** Injectable fetch (tests script this); defaults to the global. */
  fetch?: typeof fetch;
}

export interface AnswerPermissionResult {
  ok: boolean;
  /** Machine-readable failure: the route's error code, or "network". */
  code?: string;
  /** HTTP status, 0 for a network/transport failure. */
  status: number;
}

/**
 * Answer one permission card. Never throws: the caller's UI already flipped
 * the card optimistically, and a failed answer must surface as a toast, not
 * an unhandled rejection. A 404 is the interesting case — the prompt was
 * already answered (another tab) or its session closed — so it is reported
 * as `not_found` rather than as a generic failure.
 */
export async function answerPermission(
  opts: AnswerPermissionOptions,
): Promise<AnswerPermissionResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(
      `/api/permissions/${encodeURIComponent(opts.requestId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: opts.decision }),
      },
    );
  } catch {
    return { ok: false, code: "network", status: 0 };
  }

  if (response.ok) return { ok: true, status: response.status };

  let code = "unknown";
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // An unreadable body still leaves the status as the identifying fact.
  }
  return { ok: false, code, status: response.status };
}

// -- internals ---------------------------------------------------------------

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human-readable failure for a non-2xx: code + the route's error field. */
async function failureMessage(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    // unreadable body — the status alone still identifies the failure
  }
  return detail
    ? `request failed (${String(response.status)}): ${detail}`
    : `request failed: HTTP ${String(response.status)}`;
}
