import { describe, it, expect, vi } from "vitest";
import { answerPermission, runTurn } from "./turn-client";
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

  it("sends the model override when present and never a resume id", async () => {
    const f = vi.fn(async () => sseResponse([END_FRAME]));
    await runTurn({ ...BASE, fetch: f, model: "opus", onEvent: () => {} });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("opus");
    // The resume target is the server's own column, not a client claim: the
    // browser cannot name a CLI session to attach to.
    expect(body).not.toHaveProperty("resumeSessionId");
  });

  it("delivers events as frames arrive, not at stream end", async () => {
    // Deterministic, not timing-based: frame 2 is only enqueued once frame 1
    // has been DELIVERED. A reader that buffered to stream end would never
    // reach the enqueue, so the gate would time out instead of racing a clock.
    const encoder = new TextEncoder();
    let releaseSecond: () => void = () => {};
    const firstDelivered = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(TEXT_FRAME));
        await firstDelivered;
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
    const received: TurnEvent[] = [];
    await runTurn({
      ...BASE,
      fetch: f,
      onEvent: (event) => {
        received.push(event);
        if (received.length === 1) releaseSecond();
      },
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(received.map((e) => e.type)).toEqual(["text_delta", "turn_end"]);
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

  it("reports acceptance before the first event, and never on a failure", async () => {
    // The URL settles on acceptance: the row exists the moment the route
    // answers, which can be long before the model's first token.
    const order: string[] = [];
    await runTurn({
      ...BASE,
      fetch: async () => sseResponse([TEXT_FRAME, END_FRAME]),
      onEvent: () => order.push("event"),
      onAccepted: () => order.push("accepted"),
    });
    expect(order[0]).toBe("accepted");
    expect(order.filter((o) => o === "accepted")).toHaveLength(1);

    // A refused POST left no row behind, so nothing may claim acceptance.
    let accepted = 0;
    await runTurn({
      ...BASE,
      fetch: async () => new Response('{"error":"forbidden"}', { status: 403 }),
      onEvent: () => {},
      onAccepted: () => {
        accepted += 1;
      },
    });
    expect(accepted).toBe(0);
  });
});

describe("answerPermission", () => {
  it("POSTs the decision to the request's route", async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    await expect(
      answerPermission({ requestId: "req-1", decision: "allow", fetch: f }),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/permissions/req-1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ decision: "allow" });
  });

  it("encodes the request id into the path (it is a URL segment)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await answerPermission({ requestId: "a/b c", decision: "deny", fetch: f });
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe("/api/permissions/a%2Fb%20c");
  });

  it("reports a 404 as not_found (already answered or expired)", async () => {
    const f = vi.fn(
      async () => new Response('{"error":"not_found"}', { status: 404 }),
    );
    await expect(
      answerPermission({ requestId: "req-1", decision: "allow", fetch: f }),
    ).resolves.toEqual({ ok: false, code: "not_found", status: 404 });
  });

  it("reports a network failure instead of throwing", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      answerPermission({ requestId: "req-1", decision: "allow", fetch: f }),
    ).resolves.toMatchObject({ ok: false, status: 0 });
  });
});
