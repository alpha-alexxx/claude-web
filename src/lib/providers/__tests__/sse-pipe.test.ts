import { describe, it, expect, vi, afterEach } from "vitest";
import { createTurnSsePipe, type SseSession } from "../claude/sse-pipe";
import type { TurnEvent } from "../types";

/**
 * SSE pipe tests: TurnEvents → SSE ReadableStream with heartbeat and hard
 * turn timeout. Timers faked; no CLI spawned.
 */

function makeSession(sendError?: Error): {
  session: SseSession;
  recorded: { interrupted: number; offEventCalls: number; sent: string[] };
  push: (e: TurnEvent) => void;
} {
  const recorded = { interrupted: 0, offEventCalls: 0, sent: [] as string[] };
  let cb: ((e: TurnEvent) => void) | null = null;
  const session: SseSession = {
    onEvent: (fn) => {
      cb = fn;
    },
    offEvent: () => {
      recorded.offEventCalls += 1;
      cb = null;
    },
    interrupt: async () => {
      recorded.interrupted += 1;
    },
    send: async (text) => {
      recorded.sent.push(text);
      if (sendError) throw sendError;
    },
  };
  return { session, recorded, push: (e: TurnEvent) => cb?.(e) };
}

/** Read every SSE frame from the stream until it closes. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    frames.push(...decoder.decode(value).split("\n\n").filter(Boolean));
  }
  return frames;
}

afterEach(() => {
  vi.useRealTimers();
});

const TURN_END: TurnEvent = {
  type: "turn_end",
  reason: "done",
  model: "m",
  durationMs: 1,
  costUsd: 0,
  tokens: { input: 1, output: 2 },
  error: null,
};

describe("createTurnSsePipe", () => {
  it("streams events as SSE data frames and closes after turn_end", async () => {
    vi.useFakeTimers();
    const { session, push, recorded } = makeSession();
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 30_000,
      heartbeatMs: 20_000,
    });
    const all = readAll(pipe.stream); // background reader
    await vi.advanceTimersByTimeAsync(0);
    await pipe.send("hello"); // pipe owns the send — listener attached first
    push({ type: "text_delta", text: "hi" });
    push(TURN_END);
    const frames = await all;
    expect(recorded.sent).toEqual(["hello"]);
    expect(frames.some((f) => f.includes('data: {"type":"text_delta"'))).toBe(true);
    expect(frames.some((f) => f.includes('data: {"type":"turn_end"'))).toBe(true);
    // turn completed fast — no heartbeat ever fired
    expect(frames.every((f) => !f.includes("heartbeat"))).toBe(true);
  });

  it("heartbeats with an SSE comment while the turn runs silently", async () => {
    vi.useFakeTimers();
    const { session, push } = makeSession();
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 90_000,
      heartbeatMs: 20_000,
    });
    const reader = pipe.stream.getReader();
    const decoder = new TextDecoder();
    push({ type: "text_delta", text: "working" });
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain("text_delta");
    // 20 s of silence — heartbeat comment frame must arrive, stream stays open
    await vi.advanceTimersByTimeAsync(20_000);
    const beat = await reader.read();
    expect(decoder.decode(beat.value)).toBe(": heartbeat\n\n");
    // stream still open (no turn_end yet): a second heartbeat flows
    await vi.advanceTimersByTimeAsync(20_000);
    const beat2 = await reader.read();
    expect(decoder.decode(beat2.value)).toBe(": heartbeat\n\n");
    await reader.cancel();
  });

  it("hard-times-out a running turn: synthetic timeout turn_end + interrupt + close", async () => {
    vi.useFakeTimers();
    const { session, recorded, push } = makeSession();
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 5_000,
      heartbeatMs: 20_000,
    });
    const all = readAll(pipe.stream);
    await vi.advanceTimersByTimeAsync(1);
    push({ type: "text_delta", text: "stuck" });
    await vi.advanceTimersByTimeAsync(10_000); // past the timeout
    const frames = await all;
    expect(recorded.interrupted).toBe(1);
    const rearFrame = frames.find((f) => f.includes("turn_end"));
    expect(rearFrame).toBeDefined();
    expect(rearFrame).toContain("timed out");
  });

  it("on send failure, emits an error turn_end and closes (never a hung tab)", async () => {
    vi.useFakeTimers();
    const { session } = makeSession(new Error("pool at capacity"));
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 30_000,
      heartbeatMs: 20_000,
    });
    const all = readAll(pipe.stream);
    await vi.advanceTimersByTimeAsync(0);
    await pipe.send("hi");
    const frames = await all;
    const end = frames.find((f) => f.includes("turn_end"));
    expect(end).toContain("pool at capacity");
  });

  it("cancel() detaches the listener but never interrupts (turn keeps running)", async () => {
    vi.useFakeTimers();
    const { session, recorded } = makeSession();
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 30_000,
      heartbeatMs: 20_000,
    });
    const reader = pipe.stream.getReader();
    await vi.advanceTimersByTimeAsync(1);
    await reader.cancel(); // client disconnected mid-turn
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recorded.offEventCalls).toBe(1);
    expect(recorded.interrupted).toBe(0); // legacy parity: turn survives reconnects
  });

  it("ignores events after turn_end (belated frames, no resurrection)", async () => {
    vi.useFakeTimers();
    const { session, push } = makeSession();
    const pipe = createTurnSsePipe(session, {
      timeoutMs: 30_000,
      heartbeatMs: 20_000,
    });
    const all = readAll(pipe.stream);
    await vi.advanceTimersByTimeAsync(1);
    push(TURN_END);
    await vi.advanceTimersByTimeAsync(5);
    push({ type: "text_delta", text: "too late" });
    const frames = await all;
    expect(frames.filter((f) => f.startsWith("data:")).length).toBe(1);
  });
});
