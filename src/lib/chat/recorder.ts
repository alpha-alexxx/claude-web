import type { TurnEvent } from "@/lib/providers/types";
import {
  initialView,
  pushUserMessage,
  reduceTurnEvent,
  type TurnView,
} from "@/lib/client/chat-view";
import type { MessageRow } from "@/lib/db/messages-repo";
import {
  assistantMessageContent,
  userMessageContent,
} from "./transcript";

/**
 * TurnRecorder — mirrors a live turn into the same pure view-model reducer the
 * browser uses, and flushes finished turns to SQLite.
 *
 * Why a second reducer rather than persisting raw events: a transcript is only
 * useful if it renders. Storing the reduced view means replay is a
 * deserialize, and the server cannot drift from the client — both call the
 * SAME reducer (chat-view.ts), so a block the UI knows how to show is exactly
 * a block that gets stored.
 *
 * Lifecycle:
 *   begin(text)   → user message row (immediately: a turn that dies before
 *                   any frame must still leave the user's prompt in history)
 *   record(event) → accumulate; on turn_end, write the assistant row
 *   finish()      → detach-safe flush of a turn that ended without turn_end
 *
 * Flushing on `turn_end` rather than on stream close matters: a tool can
 * finish AFTER this turn's SSE stream closed (disconnect does not kill the
 * turn, ledgered Phase 3c), and the turn's own end frame is the point where
 * its content is final.
 */

export interface RecorderSink {
  appendUser(text: string): void;
  appendAssistant(view: TurnView): void;
}

export interface TurnRecorder {
  /** Push the user's message into the view model (and persist it). */
  begin(text: string): void;
  /** Feed one stream event; a turn_end flushes the assistant row. */
  record(event: TurnEvent): void;
  /**
   * Flush whatever has accumulated. Call on send failure / stream teardown —
   * idempotent, so calling it after a turn_end writes nothing.
   */
  finish(): void;
}

export function createTurnRecorder(sink: RecorderSink): TurnRecorder {
  let view = initialView();
  let dirty = false;
  // A per-turn view is what gets written; `flushed` stops a torn-down stream
  // from writing the same turn twice (turn_end, then finish()).
  let flushed = false;

  const flush = () => {
    if (flushed || !dirty) return;
    flushed = true;
    sink.appendAssistant(view);
    dirty = false;
  };

  return {
    begin(text) {
      view = pushUserMessage(view, text);
      dirty = true;
      sink.appendUser(text);
    },
    record(event) {
      view = reduceTurnEvent(view, event);
      dirty = true;
      if (event.type === "turn_end") flush();
    },
    finish() {
      if (view.running) {
        // No turn_end arrived (process died, stream torn down): the partial
        // assistant content is still worth keeping, so close it as an error
        // the same way the client's own reducer would.
        view = reduceTurnEvent(view, {
          type: "turn_end",
          reason: "error",
          model: null,
          durationMs: 0,
          costUsd: null,
          tokens: { input: null, output: null },
          error: "turn ended without a final result",
        });
        dirty = true;
      }
      flush();
    },
  };
}

/**
 * SQLite-backed sink. Writes are swallowed and logged, exactly like the audit
 * trail: a storage failure must not break a live turn. The transcript is the
 * record of a conversation, not a gate on it.
 */
export function createDbSink(
  append: (row: { role: MessageRow["role"]; content: Record<string, unknown> }) => void,
): RecorderSink {
  return {
    appendUser(text) {
      try {
        append({ role: "user", content: userMessageContent(text) });
      } catch (err) {
        console.error("[transcript] user write failed:", messageOf(err));
      }
    },
    appendAssistant(view) {
      // Only the turn that was just written is persisted — the view holds the
      // whole conversation and re-writing it would duplicate every earlier
      // turn. The last entry is this turn by construction (begin/record only
      // ever append or extend the tail).
      const turn = view.turns.at(-1);
      if (!turn || turn.kind !== "assistant") return;
      try {
        append({ role: "assistant", content: assistantMessageContent(turn) });
      } catch (err) {
        console.error("[transcript] assistant write failed:", messageOf(err));
      }
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
