import { describe, it, expect } from "vitest";
import { createTurnRecorder, type RecorderSink } from "../recorder";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * The recorder is what makes a conversation survive the process. Two
 * invariants matter: (1) the user's prompt is persisted even if the turn dies
 * before a single frame, and (2) one turn is written exactly once — a
 * disconnected stream calling finish() after the turn already ended must not
 * duplicate the assistant row.
 */

function sink(): RecorderSink & { users: string[]; assistants: unknown[] } {
  const users: string[] = [];
  const assistants: unknown[] = [];
  return {
    users,
    assistants,
    appendUser: (text: string) => users.push(text),
    appendAssistant: (view) => assistants.push(view),
  };
}

const end = (reason: "done" | "error" = "done"): TurnEvent => ({
  type: "turn_end",
  reason,
  model: "sonnet",
  durationMs: 5,
  costUsd: 0.02,
  tokens: { input: 1, output: 2 },
  error: reason === "error" ? "boom" : null,
});

describe("createTurnRecorder", () => {
  it("persists the user message before any event arrives", () => {
    const s = sink();
    createTurnRecorder(s).begin("hello");
    expect(s.users).toEqual(["hello"]);
    expect(s.assistants).toHaveLength(0);
  });

  it("flushes one assistant row on turn_end", () => {
    const s = sink();
    const r = createTurnRecorder(s);
    r.begin("hello");
    r.record({ type: "text_delta", text: "hi " });
    r.record({ type: "text_delta", text: "there" });
    expect(s.assistants).toHaveLength(0); // nothing until the turn ends
    r.record(end());
    expect(s.assistants).toHaveLength(1);
    const view = s.assistants[0] as {
      turns: Array<{ kind: string; blocks?: Array<{ kind: string; text: string }> }>;
    };
    const assistant = view.turns.at(-1);
    expect(assistant?.kind).toBe("assistant");
    expect(assistant?.blocks).toEqual([{ kind: "text", text: "hi there" }]);
  });

  it("writes the turn exactly once when finish() follows turn_end", () => {
    const s = sink();
    const r = createTurnRecorder(s);
    r.begin("hello");
    r.record({ type: "text_delta", text: "x" });
    r.record(end());
    r.finish();
    r.finish();
    expect(s.assistants).toHaveLength(1);
  });

  it("closes a torn-down turn as an error and keeps its partial content", () => {
    const s = sink();
    const r = createTurnRecorder(s);
    r.begin("hello");
    r.record({ type: "text_delta", text: "partial" });
    r.finish();
    expect(s.assistants).toHaveLength(1);
    const view = s.assistants[0] as {
      turns: Array<{ kind: string; blocks?: unknown[]; end?: { reason: string } }>;
    };
    const assistant = view.turns.at(-1);
    expect(assistant?.blocks).toHaveLength(1);
    expect(assistant?.end?.reason).toBe("error");
  });

  it("writes nothing when finish() is called before begin()", () => {
    const s = sink();
    createTurnRecorder(s).finish();
    expect(s.assistants).toHaveLength(0);
    expect(s.users).toHaveLength(0);
  });

  it("passes tool and permission blocks through the shared reducer", () => {
    const s = sink();
    const r = createTurnRecorder(s);
    r.begin("run ls");
    r.record({
      type: "tool_start",
      id: "t1",
      name: "Bash",
      summary: "ls",
      input: { command: "ls" },
      parentToolUseId: null,
    });
    r.record({ type: "tool_end", id: "t1", ok: true, output: "a" });
    r.record({
      type: "permission_request",
      requestId: "r1",
      toolName: "Bash",
      toolUseId: "t2",
      input: { command: "rm x" },
      displayHint: "Bash(rm x)",
    });
    r.record(end());
    const view = s.assistants[0] as { turns: Array<{ blocks: Array<{ kind: string }> }> };
    expect(view.turns.at(-1)?.blocks.map((b) => b.kind)).toEqual([
      "tool",
      "permission",
    ]);
  });
});
