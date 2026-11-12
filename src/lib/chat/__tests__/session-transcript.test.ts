import { describe, it, expect } from "vitest";
import {
  attachSessionTranscript,
  captureCliSessionId,
  resetSessionTranscriptForTest,
} from "../session-transcript";
import type { RecorderSink } from "../recorder";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * The session mirror is deliberately session-lifetime, not stream-lifetime:
 * a closed tab does not end the turn (ledgered Phase 3c), so a transcript
 * that followed the SSE stream would silently drop everything the agent did
 * after the user navigated away. It follows the session instead, exactly like
 * the tool-call audit listener.
 */

const end: TurnEvent = {
  type: "turn_end",
  reason: "done",
  model: "sonnet",
  durationMs: 5,
  costUsd: 0.01,
  tokens: { input: 1, output: 2 },
  error: null,
};

function harness() {
  const listeners = new Set<(e: TurnEvent) => void>();
  const users: string[] = [];
  const assistants: Array<{ turns: Array<{ kind: string; blocks?: unknown[] }> }> = [];
  const sink: RecorderSink = {
    appendUser: (text) => users.push(text),
    appendAssistant: (view) => assistants.push(view as never),
  };
  const session = {
    onEvent: (cb: (e: TurnEvent) => void) => listeners.add(cb),
    offEvent: (cb: (e: TurnEvent) => void) => listeners.delete(cb),
  };
  const emit = (e: TurnEvent) => {
    for (const cb of [...listeners]) cb(e);
  };
  return { session, sink, users, assistants, emit, listeners };
}

describe("attachSessionTranscript", () => {
  it("stores a turn from session events", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    const t = attachSessionTranscript(h.session, h.sink);
    t.beginTurn("hello");
    h.emit({ type: "text_delta", text: "hi" });
    h.emit(end);
    expect(h.users).toEqual(["hello"]);
    expect(h.assistants).toHaveLength(1);
  });

  it("keeps recording after the SSE stream is gone (session-lifetime)", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    const t = attachSessionTranscript(h.session, h.sink);
    t.beginTurn("long job");
    // The browser disconnected: no pipe listener remains, but this one does.
    h.emit({ type: "text_delta", text: "still " });
    h.emit({ type: "text_delta", text: "working" });
    h.emit(end);
    const view = h.assistants[0] as {
      turns: Array<{ blocks: Array<{ kind: string; text: string }> }>;
    };
    expect(view.turns.at(-1)?.blocks[0].text).toBe("still working");
  });

  it("attaches one listener per session no matter how many turns", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    const t1 = attachSessionTranscript(h.session, h.sink);
    t1.beginTurn("one");
    h.emit(end);
    const t2 = attachSessionTranscript(h.session, h.sink);
    t2.beginTurn("two");
    h.emit(end);
    expect(h.listeners.size).toBe(1);
    expect(h.users).toEqual(["one", "two"]);
    expect(h.assistants).toHaveLength(2);
  });

  it("closes an unfinished turn before starting the next one", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    const t = attachSessionTranscript(h.session, h.sink);
    t.beginTurn("one");
    h.emit({ type: "text_delta", text: "partial" });
    t.beginTurn("two"); // previous turn never got a turn_end
    const torn = h.assistants[0] as {
      turns: Array<{ end?: { reason: string }; blocks: unknown[] }>;
    };
    expect(torn.turns.at(-1)?.end?.reason).toBe("error");
    expect(torn.turns.at(-1)?.blocks).toHaveLength(1);
  });

  it("ignores events that belong to no recorded turn", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    attachSessionTranscript(h.session, h.sink);
    h.emit({ type: "tool_end", id: "x", ok: true, output: "late" });
    expect(h.assistants).toHaveLength(0);
    expect(h.users).toHaveLength(0);
  });

  it("stops recording a turn once it ended", () => {
    resetSessionTranscriptForTest();
    const h = harness();
    const t = attachSessionTranscript(h.session, h.sink);
    t.beginTurn("x");
    h.emit(end);
    expect(t.isRecording()).toBe(false);
    h.emit({ type: "text_delta", text: "late" });
    expect(h.assistants).toHaveLength(1);
  });
});

describe("captureCliSessionId", () => {
  it("persists the CLI session id as soon as the session exposes it", () => {
    const listeners = new Set<(e: TurnEvent) => void>();
    let id: string | null = null;
    const seen: string[] = [];
    const session = {
      onEvent: (cb: (e: TurnEvent) => void) => listeners.add(cb),
      offEvent: (cb: (e: TurnEvent) => void) => listeners.delete(cb),
    };
    captureCliSessionId(session, () => id, (v) => seen.push(v));
    id = "cli-1";
    for (const cb of [...listeners]) cb({ type: "text_delta", text: "x" });
    expect(seen).toEqual(["cli-1"]);
    expect(listeners.size).toBe(0); // detached after capture
  });

  it("detaches at turn_end when the id never appeared", () => {
    const listeners = new Set<(e: TurnEvent) => void>();
    const session = {
      onEvent: (cb: (e: TurnEvent) => void) => listeners.add(cb),
      offEvent: (cb: (e: TurnEvent) => void) => listeners.delete(cb),
    };
    captureCliSessionId(session, () => null, () => {});
    for (const cb of [...listeners]) cb(end);
    expect(listeners.size).toBe(0);
  });

  it("swallows a failing persist — a storage error must not break the turn", () => {
    const listeners = new Set<(e: TurnEvent) => void>();
    const session = {
      onEvent: (cb: (e: TurnEvent) => void) => listeners.add(cb),
      offEvent: (cb: (e: TurnEvent) => void) => listeners.delete(cb),
    };
    captureCliSessionId(session, () => "cli-1", () => {
      throw new Error("disk full");
    });
    expect(() => {
      for (const cb of [...listeners]) cb(end);
    }).not.toThrow();
  });
});
