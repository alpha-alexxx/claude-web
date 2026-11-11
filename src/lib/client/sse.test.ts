import { describe, it, expect } from "vitest";
import { SseFrameParser } from "./sse";

/**
 * Client-side SSE parser. The browser's EventSource cannot POST (and the
 * chat turn IS a POST), so the client reads the response body itself and
 * feeds chunks through this parser. It must handle frames split across
 * chunk boundaries, multiple frames per chunk, and comment heartbeats.
 */

describe("SseFrameParser", () => {
  it("parses a single complete data frame", () => {
    const p = new SseFrameParser();
    const events = p.push('data: {"type":"text_delta","text":"hi"}\n\n');
    expect(events).toEqual([{ type: "text_delta", text: "hi" }]);
  });

  it("parses multiple frames in one chunk", () => {
    const p = new SseFrameParser();
    const events = p.push(
      'data: {"type":"text_delta","text":"a"}\n\ndata: {"type":"text_delta","text":"b"}\n\n',
    );
    expect(events).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
    ]);
  });

  it("buffers a frame split across chunks", () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"type":"text_del')).toEqual([]);
    expect(p.push('ta","text":"hi"}\n\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });

  it("ignores comment heartbeat frames", () => {
    const p = new SseFrameParser();
    expect(p.push(": heartbeat\n\n")).toEqual([]);
  });

  it("ignores malformed JSON without throwing", () => {
    const p = new SseFrameParser();
    expect(p.push("data: {not json}\n\n")).toEqual([]);
    // and keeps working afterwards
    expect(p.push('data: {"type":"turn_end","reason":"done"}\n\n')).toEqual([
      { type: "turn_end", reason: "done" },
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"type":"text_delta","text":"hi"}\r\n\r\n')).toEqual([
      { type: "text_delta", text: "hi" },
    ]);
  });

  it("joins multi-line data fields within one frame", () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"type":"text_delta",\ndata: "text":"hi"}\n\n')).toEqual(
      [{ type: "text_delta", text: "hi" }],
    );
  });

  it("drops a trailing partial frame until completed", () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"type":"text_delta","text":"hi"}')).toEqual([]);
    expect(p.push("\n\n")).toEqual([{ type: "text_delta", text: "hi" }]);
  });
});
