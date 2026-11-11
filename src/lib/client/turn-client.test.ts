import { describe, it, expect, vi } from "vitest";
import { runTurn } from "./turn-client";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * turn-client: browser-side transport for one chat turn — fetch POST,
 * SSE parsing, TurnEvent callbacks. `fetch` is scripted here; auth and
 * body validation live in the route tests.
 *
 * Contract pinned:
 * - one POST to /api/chat with the exact body the route validates
 * - events delivered as frames arrive (not buffered to stream end)
 * - non-2xx or network failure becomes one error turn_end
 * - the promise resolves on the stream's turn_end
 */

const TEXT_FRAME = 'data: {"type":"text_delta","text":"Hello"}\n\n';
const END_FRAME =
  'data: {"type":"turn_end","reason":"done","model":"sonnet","durationMs":1,"costUsd":0.01,"tokens":{"input":1,"output":1},"error":null}\n\n';

const BASE = {
  conversationId: "c1",
  provider: "claude",
  cwd: "/w",
  text: "hi",
};

function sseResponse(frames: string[], status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const f of frames) {
        controller.enqueue(encoder.encode(f));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("runTurn", () => {
  it("POSTs once with the body the chat route expects", async () => {
    const f = vi.fn(async () => sseResponse([TEXT_FRAME, END_FRAME]));
    const got: TurnEvent[] = [];
    await runTurn({ ...BASE, fetch: f, onEvent: (e) => got.push(e) });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(BASE);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ type: "text_delta", text: "Hello" });
  });

  it("sends model and resumeSessionId when present", async () => {
    const f = vi.fn(async () => sseResponse([END_FRAME]));
    await runTurn({
      ...BASE,
      fetch: f,
      model: "opus",
      resumeSessionId: "cli-1",
      onEvent: () => {},
    });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "opus",
      resumeSessionId: "cli-1",
    });
  });

  it("delivers events as frames arrive, not at stream end", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Two frames, each delayed. The reader must get frame 1 before
        // frame 2 is enqueued — timing proves incremental delivery.
        controller.enqueue(encoder.encode(TEXT_FRAME));
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(encoder.encode(END_FRAME));
        controller.close();
      },
    });
    const f = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const timestamps: number[] = [];
    await runTurn({
      ...BASE,
      fetch: f,
      onEvent: () => timestamps.push(Date.now()),
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(timestamps.length).toBe(2);
    // The two deliveries are separated in (real) time — incremental reads.
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(15);
  });

  it("drops corrupt frames without killing the stream", async () => {
    const f = vi.fn(async () =>
      sseResponse(["data: {not json}\n\n", TEXT_FRAME, END_FRAME]),
    );
    const got: TurnEvent[] = [];
    await runTurn({ ...BASE, fetch: f, onEvent: (e) => got.push(e) });
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ type: "text_delta", text: "Hello" });
  });

  it("surfaces a 429 as one error turn_end and resolves", async () => {
    const f = vi.fn(
      async () =>
        new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const got: TurnEvent[] = [];
    await runTurn({ ...BASE, fetch: f, onEvent: (e) => got.push(e) });
    expect(got).toHaveLength(1);
    const end = got[0];
    expect(end.type).toBe("turn_end");
    if (end.type === "turn_end") {
      expect(end.reason).toBe("error");
      expect(end.error).toMatch(/rate_limited|429/);
    }
  });

  it("survives a network fetch rejection as one error turn_end", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    });
    const got: TurnEvent[] = [];
    await runTurn({ ...BASE, fetch: f, onEvent: (e) => got.push(e) });
    expect(got).toHaveLength(1);
    const end = got[0];
    expect(end.type).toBe("turn_end");
    if (end.type === "turn_end") {
      expect(end.reason).toBe("error");
      expect(end.error).toMatch(/network|fetch|request/i);
    }
  });
});
