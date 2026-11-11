import { describe, it, expect } from "vitest";
import { mapSdkMessage, newTurnState } from "../claude/message-mapper";
import { OUTPUT_TRUNCATION_MARK } from "../types";

/** Minimal SDK-shaped assistant message with the given content blocks. */
function assistantMsg(content: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-x",
      content,
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    },
    parent_tool_use_id: null,
    uuid: "u-1",
    session_id: "sess-1",
    ...overrides,
  };
}

function streamEvent(event: unknown) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: "u-2",
    session_id: "s",
  };
}

function userToolResultMsg(blocks: unknown[]) {
  return {
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
    uuid: "u-3",
    session_id: "s",
  };
}

describe("message-mapper", () => {
  it("emits partial text and thinking deltas from stream events", () => {
    const s = newTurnState();
    const before = mapSdkMessage(
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      s,
    );
    const text = mapSdkMessage(
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      s,
    );
    const thinking = mapSdkMessage(
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } }),
      s,
    );
    expect(before).toEqual([]);
    expect(text).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(thinking).toEqual([{ type: "thinking_delta", text: "hm" }]);
  });

  it("assembles tool_use input from partial json deltas and emits tool_start on block stop", () => {
    const s = newTurnState();
    mapSdkMessage(
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "Bash" } }),
      s,
    );
    mapSdkMessage(
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command": "ls' } }),
      s,
    );
    mapSdkMessage(
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' -la"}' } }),
      s,
    );
    const out = mapSdkMessage(
      streamEvent({ type: "content_block_stop", index: 1 }),
      s,
    );
    expect(out.length).toBe(1);
    const ev = out[0];
    expect(ev.type).toBe("tool_start");
    if (ev.type !== "tool_start") return;
    expect(ev.id).toBe("tu_1");
    expect(ev.name).toBe("Bash");
    expect(ev.input).toEqual({ command: "ls -la" });
    expect(ev.summary).toBe("ls -la");
  });

  it("in partial mode, full-message text/thinking blocks are not re-emitted (deltas own them)", () => {
    const s = newTurnState(); // partial mode is the default (includePartialMessages)
    mapSdkMessage(
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      s,
    );
    mapSdkMessage(
      streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
      s,
    );
    // The same text then arrives inside the full assistant message — no re-emit.
    const out = mapSdkMessage(assistantMsg([{ type: "text", text: "hi" }]), s);
    expect(out).toEqual([]);
  });

  it("in non-partial mode, full-message text and thinking blocks emit deltas once", () => {
    const s = newTurnState({ partial: false });
    const out = mapSdkMessage(
      assistantMsg([{ type: "text", text: "hi" }, { type: "thinking", thinking: "hm" }]),
      s,
    );
    expect(out).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "thinking_delta", text: "hm" },
    ]);
  });

  it("emits tool_start from a full assistant message for blocks partial mode missed", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      assistantMsg([{ type: "tool_use", id: "tu_9", name: "Read", input: { file_path: "/tmp/x" } }]),
      s,
    );
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("tool_start");
  });

  it("does not double-emit a tool whose partial stream already delivered it", () => {
    const s = newTurnState();
    // partial path delivers tu_1
    mapSdkMessage(
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "Bash" } }),
      s,
    );
    mapSdkMessage(streamEvent({ type: "content_block_stop", index: 1 }), s);
    // full assistant message repeats the same tool_use block
    const out = mapSdkMessage(
      assistantMsg([{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }]),
      s,
    );
    expect(out).toEqual([]);
  });

  it("emits tool_end from a user message tool_result", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      userToolResultMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "done", is_error: false }]),
      s,
    );
    expect(out).toEqual([{ type: "tool_end", id: "tu_1", ok: true, output: "done" }]);
  });

  it("marks error tool results ok:false", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      userToolResultMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }]),
      s,
    );
    expect(out).toEqual([{ type: "tool_end", id: "tu_1", ok: false, output: "boom" }]);
  });

  it("caps huge tool output and marks the truncation visibly", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      userToolResultMsg([
        { type: "tool_result", tool_use_id: "tu_1", content: "x".repeat(50_000), is_error: false },
      ]),
      s,
    );
    const event = out[0] as { output: string };
    // Capped well below the input, and the marker tells the reader why.
    expect(event.output.length).toBeLessThan(50_000);
    expect(event.output.endsWith(OUTPUT_TRUNCATION_MARK)).toBe(true);
    expect(event.output.startsWith("x".repeat(100))).toBe(true);
  });

  it("does not mark output that fit under the cap", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      userToolResultMsg([{ type: "tool_result", tool_use_id: "tu_1", content: "short", is_error: false }]),
      s,
    );
    expect((out[0] as { output: string }).output).toBe("short");
  });

  it("emits a single turn_end from the result message, with usage and cost", () => {
    const s = newTurnState();
    // An assistant frame sets the turn's model before the result arrives.
    mapSdkMessage(assistantMsg([{ type: "text", text: "work" }]), s);
    const out = mapSdkMessage(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1234,
        duration_api_ms: 1000,
        is_error: false,
        num_turns: 3,
        result: "final text",
        stop_reason: "end_turn",
        total_cost_usd: 0.0123,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelUsage: {},
        permission_denials: [],
        session_id: "s",
        uuid: "u-4",
      },
      s,
    );
    expect(out.length).toBe(1);
    const ev = out[0];
    expect(ev.type).toBe("turn_end");
    if (ev.type !== "turn_end") return;
    expect(ev.reason).toBe("done");
    expect(ev.costUsd).toBe(0.0123);
    expect(ev.durationMs).toBe(1234);
    expect(ev.tokens).toEqual({ input: 10, output: 20 });
    expect(ev.model).toBe("claude-x");
    expect(ev.error).toBeNull();
  });

  it("marks error results as reason error and carries the message", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      {
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 100,
        duration_api_ms: 100,
        is_error: true,
        num_turns: 1,
        result: "",
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        errors: ["boom"],
        session_id: "s",
        uuid: "u-5",
      },
      s,
    );
    expect(out.length).toBe(1);
    const ev = out[0];
    if (ev.type !== "turn_end") throw new Error("expected turn_end");
    expect(ev.reason).toBe("error");
    expect(ev.error).toBe("boom");
  });

  it("ignores a second result after turn_end was emitted (legacy parity)", () => {
    const s = newTurnState();
    const result = {
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "r",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      session_id: "s",
      uuid: "u-6",
    };
    const first = mapSdkMessage(result, s);
    const second = mapSdkMessage(result, s);
    expect(first.length).toBe(1);
    expect(second).toEqual([]);
  });

  it("ignores unknown/informational message types without throwing", () => {
    const s = newTurnState();
    for (const bogus of [
      { type: "system", subtype: "init", session_id: "s", uuid: "u7" },
      { type: "system", subtype: "session_state_changed", state: "idle" },
      { type: "totally_unknown_kind", foo: 1 },
    ]) {
      expect(mapSdkMessage(bogus, s)).toEqual([]);
    }
  });

  it("propagates subagent parent_tool_use_id into tool_start.parentToolUseId", () => {
    const s = newTurnState();
    const out = mapSdkMessage(
      assistantMsg([{ type: "tool_use", id: "tu_sub", name: "Read", input: { file_path: "/y" } }], {
        parent_tool_use_id: "tu_parent",
      }),
      s,
    );
    const ev = out[0];
    if (ev.type !== "tool_start") throw new Error("expected tool_start");
    expect(ev.parentToolUseId).toBe("tu_parent");
  });

  it("tool summaries: command for Bash, path for Read, question for AskUserQuestion", () => {
    const mk = (name: string, input: Record<string, unknown>) => {
      const st = newTurnState();
      const out = mapSdkMessage(assistantMsg([{ type: "tool_use", id: `t-${name}`, name, input }]), st);
      const ev = out[0];
      if (ev.type !== "tool_start") throw new Error("no tool_start");
      return ev.summary;
    };
    expect(mk("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(mk("Read", { file_path: "/a/b.txt" })).toBe("/a/b.txt");
    expect(mk("AskUserQuestion", { questions: [{ question: "Which?", options: [] }] })).toBe("Which?");
    // Unknown tool falls back to a compact JSON preview
    expect(mk("mcp__server__tool", { a: 1 })).toBe('{"a":1}');
  });
});
