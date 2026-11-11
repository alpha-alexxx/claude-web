import type { TurnEvent } from "@/lib/providers/types";

/**
 * Client-side SSE frame parser.
 *
 * EventSource can't POST, and a chat turn IS a POST — so the client reads the
 * fetch response body itself and feeds decoded chunks through this parser.
 * It handles frames split across chunk boundaries, several frames per chunk,
 * multi-line `data:` fields, CRLF, and comment heartbeats (which carry no
 * events; their only job is keeping proxies from idling the connection out).
 *
 * Deliberately strict about one thing: a `data:` frame that is not valid
 * JSON is dropped, not thrown — a single corrupt frame must never kill the
 * turn stream.
 */

export class SseFrameParser {
  private buffer = "";

  /**
   * Feed one decoded chunk; returns the events of all now-complete frames.
   * The same parser instance is reused across chunks (state is the partial
   * frame at the tail of the buffer).
   */
  push(chunk: string): TurnEvent[] {
    // Normalize CRLF → LF once, on the way in.
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: TurnEvent[] = [];
    // A frame ends at a blank line. Watch for the case where \r arrives as
    // its own chunk before the \n (handled by the replace above).
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const event = parseFrame(rawFrame);
      if (event) events.push(event);
    }
    return events;
  }

  /** Flush any trailing complete-frame (call if the stream closed). */
  end(): TurnEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const event = parseFrame(rest);
    return event ? [event] : [];
  }
}

function parseFrame(rawFrame: string): TurnEvent | null {
  // Join multi-line data fields: per the SSE spec, consecutive `data:` lines
  // are one payload joined by \n. Comment lines (starting with `:`) are
  // ignored — that includes the server's heartbeat frames.
  const dataLines: string[] = [];
  for (const line of rawFrame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // lines that are neither data nor comments (id:, event:, retry:) are
    // ignored — the chat stream only ever uses data frames.
  }
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as TurnEvent;
  } catch {
    return null; // corrupt frame → drop, never kill the stream
  }
}
