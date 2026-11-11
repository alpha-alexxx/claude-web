import { SseFrameParser } from "./sse";
import { turnErrorEvent } from "./chat-view";
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
