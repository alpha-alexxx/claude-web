import type { TurnEvent } from "../types";

/**
 * Turn → SSE pipe. The last stage between a provider's TurnEvent stream and
 * the browser: it owns exactly one listener on the session, serializes frames
 * as `data: <json>\n\n`, guards a silent connection with comment frames,
 * enforces the hard turn timeout, and closes after `turn_end`.
 *
 * The pipe owns the send: the listener attaches BEFORE the prompt is pushed,
 * so no frame (especially the session's first text_delta) can be missed to a
 * race. A failed send — pool at capacity, dead CLI — becomes a synthetic
 * error turn_end, never a hung tab.
 *
 * Disconnect semantics (legacy `server.py:630` parity, ledgered): cancelling
 * the stream detaches the listener but NEVER interrupts — the agent keeps
 * working while the tab is closed; the next request re-attaches to the same
 * pool session.
 */

/** The slice of an ActiveSession the pipe needs (pool-agnostic, testable). */
export interface SseSession {
  send(text: string): Promise<void>;
  onEvent(cb: (event: TurnEvent) => void): void;
  offEvent(cb: (event: TurnEvent) => void): void;
  interrupt(): Promise<void>;
}

export interface SsePipeOpts {
  /** Hard limit for a single turn; expiry interrupts and closes the stream. */
  timeoutMs: number;
  /** Silence interval after which a `: heartbeat` comment frame is written. */
  heartbeatMs: number;
}

export interface TurnSsePipe {
  /** The SSE body stream — hand straight to `new Response()`. */
  stream: ReadableStream<Uint8Array>;
  /**
   * Push the user's prompt. Resolves when the session accepted it (not when
   * the turn completes). Attaches the listener first, then sends, and
   * converts a send rejection into an error turn_end on the stream.
   */
  send(text: string): Promise<void>;
}

const encoder = new TextEncoder();

function frame(event: TurnEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/** The timeout turn_end the client renders like any other end-of-turn. */
function timeoutEvent(startedAt: number): TurnEvent {
  const elapsed = Date.now() - startedAt;
  return {
    type: "turn_end",
    reason: "error",
    model: null,
    durationMs: elapsed,
    costUsd: null,
    tokens: { input: null, output: null },
    error: `turn timed out after ${Math.round(elapsed / 1000)}s`,
  };
}

export function createTurnSsePipe(
  session: SseSession,
  opts: SsePipeOpts,
): TurnSsePipe {
  const { timeoutMs, heartbeatMs } = opts;
  const startedAt = Date.now();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const onEvent = (event: TurnEvent) => {
    if (closed) return; // belated frames after turn_end — never resurrect
    try {
      controller?.enqueue(frame(event));
    } catch {
      teardown(); // controller already closed by a concurrent cancel
      return;
    }
    if (event.type === "turn_end") finish();
  };

  /** Detach every timer/listener. Idempotent. */
  function teardown() {
    if (heartbeat) clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
    heartbeat = null;
    timeout = null;
    session.offEvent(onEvent);
  }

  /** End the stream cleanly after turn_end (or a timeout). */
  function finish() {
    if (closed) return;
    closed = true;
    teardown();
    try {
      controller?.close();
    } catch {
      // already errored/cancelled — nothing to close
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Attach eagerly: the listener must be live before send() pushes the
      // prompt, so the first frame of the turn can never be missed.
      session.onEvent(onEvent);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller?.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          teardown();
        }
      }, heartbeatMs);
      timeout = setTimeout(() => {
        if (closed) return;
        // Emit the synthetic end BEFORE interrupting: the pool's interrupt()
        // synchronously emits its own interrupted turn_end, and the client
        // should see the timeout cause, not a bare "interrupted".
        onEvent(timeoutEvent(startedAt));
        void session.interrupt().catch(() => {});
      }, timeoutMs);
    },
    cancel() {
      // Client disconnected. Detach only — the turn keeps running
      // server-side; a reconnect re-attaches via a new pipe.
      closed = true;
      teardown();
    },
  });

  return {
    stream,
    async send(text) {
      if (closed) return;
      try {
        await session.send(text);
      } catch (err) {
        // Capacity rejection / dead CLI: end the stream with a real
        // turn_end so the client's turn lifecycle closes cleanly.
        onEvent({
          type: "turn_end",
          reason: "error",
          model: null,
          durationMs: Date.now() - startedAt,
          costUsd: null,
          tokens: { input: null, output: null },
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
