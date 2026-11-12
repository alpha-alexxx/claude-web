import type { TurnEvent } from "@/lib/providers/types";
import { createTurnRecorder, type RecorderSink } from "./recorder";

/**
 * Session-lifetime transcript mirror.
 *
 * The recorder (recorder.ts) is what actually reduces and writes a turn. This
 * module decides WHERE it listens: on the SESSION, not on the SSE pipe.
 *
 * Why it matters: a closed tab does not end a turn (ledgered — disconnect
 * detaches the pipe listener only, the agent keeps working), so a transcript
 * that followed the stream would silently lose everything the agent did after
 * the user navigated away or the proxy timed out. The tool-call audit listener
 * already sits on the session for the same reason; persistence rides with it.
 *
 * One listener per session object: the pool hands back the same object on
 * reuse, so a second turn must not stack a second mirror (every frame would be
 * recorded twice and every turn written twice).
 *
 * Turns begin explicitly (`beginTurn`) because only the route knows the user's
 * text. Frames that arrive while no turn is being recorded — a belated
 * tool_end from an earlier turn, a permission answered after the turn ended —
 * are ignored rather than folded into a phantom assistant row.
 */

export interface TranscriptSession {
  onEvent(cb: (event: TurnEvent) => void): void;
  offEvent(cb: (event: TurnEvent) => void): void;
}

export interface SessionTranscript {
  /** Start recording a turn with the user's prompt (persists it at once). */
  beginTurn(text: string): void;
  /**
   * Close the open turn: a turn that ended without a turn_end (a rejected
   * send, an aborted stream) is flushed as an error so its content survives.
   * Idempotent.
   */
  finishTurn(): void;
  isRecording(): boolean;
}

interface MirrorState {
  recorder: ReturnType<typeof createTurnRecorder> | null;
  recording: boolean;
  /**
   * The sink for the CURRENT turn. Kept here rather than captured per
   * recorder so re-attaching with a fresh sink (each request builds one from
   * the same conversation) can never strand writes on a stale closure.
   */
  sink: RecorderSink | null;
}

let mirrors = new WeakMap<object, MirrorState>();

/** Test seam: forget every attached session. */
export function resetSessionTranscriptForTest(): void {
  mirrors = new WeakMap<object, MirrorState>();
}

export function attachSessionTranscript(
  session: TranscriptSession,
  sink: RecorderSink,
): SessionTranscript {
  let state = mirrors.get(session);
  if (!state) {
    state = { recorder: null, recording: false, sink: null };
    const st = state;
    mirrors.set(session, st);
    session.onEvent((event) => {
      if (!st.recording || !st.recorder) return;
      st.recorder.record(event);
      if (event.type === "turn_end") {
        // record() already flushed on turn_end; finish() is the idempotent
        // second half that guarantees exactly one row either way.
        st.recorder.finish();
        st.recording = false;
        st.recorder = null;
      }
    });
  }
  const st = state;

  return {
    beginTurn(text) {
      // A previous turn still open (ended with no frame) is closed first so
      // its partial content is not overwritten by this turn's view.
      if (st.recorder && st.recording) st.recorder.finish();
      st.sink = sink;
      st.recorder = createTurnRecorder({
        appendUser: (t) => st.sink?.appendUser(t),
        appendAssistant: (v) => st.sink?.appendAssistant(v),
      });
      st.recording = true;
      st.recorder.begin(text);
    },
    finishTurn() {
      if (!st.recorder) return;
      st.recorder.finish();
      st.recorder = null;
      st.recording = false;
    },
    isRecording: () => st.recording,
  };
}

/**
 * Persist the CLI's own session id (the resume target) the first time it is
 * visible.
 *
 * The id appears on the init frame — long after startSession returned — so
 * this watches the session's frames and detaches as soon as it has a value (or
 * when the turn ends without one).
 *
 * A failing write is logged and swallowed: storage must never break a turn.
 */
export function captureCliSessionId(
  session: TranscriptSession,
  readId: () => string | null,
  persist: (id: string) => void,
): void {
  const tryCapture = (): boolean => {
    const id = readId();
    if (!id) return false;
    try {
      persist(id);
    } catch (err) {
      console.error(
        "[transcript] cli session id write failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    session.offEvent(listener);
    return true;
  };

  const listener = (event: TurnEvent) => {
    if (tryCapture()) return;
    if (event.type === "turn_end") session.offEvent(listener);
  };

  session.onEvent(listener);
  tryCapture();
}
