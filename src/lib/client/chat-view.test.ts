import { describe, it, expect } from "vitest";
import {
  initialView,
  pushUserMessage,
  reduceTurnEvent,
  turnErrorEvent,
  type AssistantTurn,
  type TurnView,
} from "./chat-view";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * TurnView: the pure accumulator from TurnEvent stream → renderable view
 * model. One reducer for every provider (they all speak TurnEvent); the
 * React components stay dumb renderers of this shape.
 *
 * Shape: a conversation is turns (user / assistant). One assistant turn is
 * an ordered list of BLOCKS (text, thinking, tool, permission) appended in
 * event arrival order — chat is interleaved ("let me check…", tool card,
 * "the answer is…"), so a single text field would lose that order.
 *
 * The state machine the streaming indicator needs:
 *   running=true,  started=false → "starting…" (turn accepted, no event yet)
 *   running=true,  started=true  → streaming
 *   running=false               → turn ended (usage on the assistant turn)
 */

const T = (text: string): TurnEvent => ({ type: "text_delta", text });
const THINK = (text: string): TurnEvent => ({ type: "thinking_delta", text });

const TOOL_START = (
  id: string,
  name = "Bash",
  parent: string | null = null,
): TurnEvent => ({
  type: "tool_start",
  id,
  name,
  summary: "cmd",
  input: { command: "ls" },
  parentToolUseId: parent,
});

const TOOL_END = (id: string, ok = true): TurnEvent => ({
  type: "tool_end",
  id,
  ok,
  output: "done",
});

const TURN_END: TurnEvent = {
  type: "turn_end",
  reason: "done",
  model: "sonnet",
  durationMs: 1234,
  costUsd: 0.01,
  tokens: { input: 10, output: 20 },
  error: null,
};

/** Last turn, asserted to be assistant. */
function openAssistant(v: TurnView): AssistantTurn {
  const last = v.turns[v.turns.length - 1];
  if (!last || last.kind !== "assistant") {
    throw new Error(`expected assistant turn, got ${JSON.stringify(last)}`);
  }
  return last;
}

describe("TurnView state machine", () => {
  it("initial view is idle: no turns, not running", () => {
    const v = initialView();
    expect(v.turns).toEqual([]);
    expect(v.running).toBe(false);
    expect(v.started).toBe(false);
  });

  it("a pushed user message opens the starting state", () => {
    const v = pushUserMessage(initialView(), "hi");
    expect(v.running).toBe(true);
    expect(v.started).toBe(false);
    expect(v.turns).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("the first event flips started and opens an assistant turn", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, T("Hello"));
    expect(v.started).toBe(true);
    expect(v.turns).toHaveLength(2);
    expect(openAssistant(v).blocks).toEqual([
      { kind: "text", text: "Hello" },
    ]);
  });

  it("an event without a pushed user message still opens a turn", () => {
    const v = reduceTurnEvent(initialView(), T("orphan"));
    expect(v.turns).toHaveLength(1);
    expect(openAssistant(v).blocks).toEqual([{ kind: "text", text: "orphan" }]);
  });
});

describe("block accumulation", () => {
  it("merges consecutive text deltas into one block", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, T("Hello"));
    v = reduceTurnEvent(v, T(" world"));
    expect(openAssistant(v).blocks).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("keeps thinking separate from text", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, THINK("hmm"));
    v = reduceTurnEvent(v, T("answer"));
    expect(openAssistant(v).blocks).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "answer" },
    ]);
  });

  it("text after a tool block starts a NEW text block (interleaving kept)", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, T("checking…"));
    v = reduceTurnEvent(v, TOOL_START("t1"));
    v = reduceTurnEvent(v, TOOL_END("t1"));
    v = reduceTurnEvent(v, T("the answer"));
    expect(openAssistant(v).blocks.map((b) => b.kind)).toEqual([
      "text",
      "tool",
      "text",
    ]);
  });

  it("tool_end pairs by id, records output, and marks completion", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, TOOL_START("t1", "Bash"));
    v = reduceTurnEvent(v, TOOL_END("t1", false));
    const blocks = openAssistant(v).blocks;
    const tool = blocks.find((b) => b.kind === "tool");
    if (!tool || tool.kind !== "tool") throw new Error("no tool block");
    expect(tool.tool.status).toBe("error");
    expect(tool.tool.output).toBe("done");
  });

  it("records the subagent parent for nested tool cards", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, TOOL_START("parent", "Task"));
    v = reduceTurnEvent(v, TOOL_START("child", "Bash", "parent"));
    const tool = openAssistant(v).blocks.find(
      (b) => b.kind === "tool" && b.tool.id === "child",
    );
    if (!tool || tool.kind !== "tool") throw new Error("no child block");
    expect(tool.tool.parentToolUseId).toBe("parent");
  });

  it("ignores a tool_end with no matching start (never throws)", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, TOOL_END("ghost"));
    expect(v.turns).toHaveLength(1); // just the user message
  });

  it("opens a pending permission card block", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, {
      type: "permission_request",
      requestId: "req-1",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: { command: "rm -rf /" },
      displayHint: "Bash(rm -rf /)",
    });
    const cards = openAssistant(v).blocks.filter((b) => b.kind === "permission");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (card.kind !== "permission") throw new Error("unreachable");
    expect(card.card.requestId).toBe("req-1");
    expect(card.card.toolName).toBe("Bash");
    expect(card.card.status).toBe("pending");
  });
});

describe("turn end and multi-turn", () => {
  it("turn_end attaches usage to the assistant turn and stops the stream", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, T("Hello"));
    v = reduceTurnEvent(v, TURN_END);
    const turn = openAssistant(v);
    expect(turn.end).toMatchObject({
      reason: "done",
      model: "sonnet",
      costUsd: 0.01,
    });
    expect(v.running).toBe(false);
  });

  it("an error turn_end surfaces its error message", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, {
      type: "turn_end",
      reason: "error",
      model: null,
      durationMs: 1,
      costUsd: null,
      tokens: { input: null, output: null },
      error: "claude process ended unexpectedly",
    });
    const turn = openAssistant(v);
    expect(turn.end?.reason).toBe("error");
    expect(turn.end?.error).toBe("claude process ended unexpectedly");
  });

  it("a second turn never touches the first", () => {
    let v = pushUserMessage(initialView(), "one");
    v = reduceTurnEvent(v, T("first"));
    v = reduceTurnEvent(v, TURN_END);
    v = pushUserMessage(v, "two");
    v = reduceTurnEvent(v, T("second"));
    expect(v.turns.map((t) => t.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(v.running).toBe(true);
    expect(openAssistant(v).blocks).toEqual([{ kind: "text", text: "second" }]);
  });

  it("pushUserMessage closes a still-open turn as an error (reconnect case)", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, T("partial"));
    // stream dropped without turn_end
    v = pushUserMessage(v, "again");
    const first = v.turns.find(
      (t) => t.kind === "assistant",
    ) as AssistantTurn | undefined;
    expect(first?.end?.reason).toBe("error");
    expect(first?.end?.error).toMatch(/connection/i);
  });
});

describe("client-side POST failure", () => {
  it("turnErrorEvent reduces like a server error end", () => {
    let v = pushUserMessage(initialView(), "hi");
    v = reduceTurnEvent(v, turnErrorEvent("pool at capacity"));
    const turn = openAssistant(v);
    expect(turn.end?.reason).toBe("error");
    expect(turn.end?.error).toBe("pool at capacity");
    expect(v.running).toBe(false);
  });
});

describe("immutability", () => {
  it("every reduce returns a fresh view; inputs are never mutated", () => {
    const v0 = pushUserMessage(initialView(), "hi");
    const snapshot = JSON.stringify(v0);
    const v1 = reduceTurnEvent(v0, T("a"));
    expect(v1).not.toBe(v0);
    expect(v1.turns).not.toBe(v0.turns);
    expect(JSON.stringify(v0)).toBe(snapshot);
    const v2 = reduceTurnEvent(v1, TOOL_START("t1"));
    expect(v2).not.toBe(v1);
    expect(JSON.stringify(v1)).not.toBe(JSON.stringify(v2)); // changed state
  });
});
