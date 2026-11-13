import { describe, it, expect } from "vitest";
import {
  mapOpenCodeEvent,
  newOpenCodeTurnState,
  finishOpenCodeTurn,
} from "../opencode/message-mapper";
import { OUTPUT_TRUNCATION_MARK } from "../types";

/**
 * Fixtures are shaped exactly like `opencode run --format json` NDJSON lines
 * (v2.2.6): every frame is `{ type, timestamp, sessionID, ...data }`, and the
 * renderer emits each tool exactly ONCE, already terminal, as `tool_use`.
 *
 * The mapper takes unknown JSON so a newer CLI's extra frames are ignored
 * rather than crashing a live turn.
 */

function state() {
  return newOpenCodeTurnState({ model: "anthropic/claude-sonnet-4", startedAt: 1000, now: () => 1500 });
}

function textFrame(text: string, type: "text" | "reasoning" = "text") {
  return {
    type,
    timestamp: 1400,
    sessionID: "ses_1",
    part: {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type,
      text,
      time: { start: 1300, end: 1400 },
    },
  };
}

function toolFrame(tool: string, input: Record<string, unknown>, state_: Record<string, unknown>) {
  return {
    type: "tool_use",
    timestamp: 1400,
    sessionID: "ses_1",
    part: {
      partID: "prt_tool",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "tool",
      id: "tool_1",
      tool,
      state: { input, ...state_ },
    },
  };
}

function stepFinish(cost: number, input: number, output: number, idx = 0) {
  return {
    type: "step_finish",
    timestamp: 1450,
    sessionID: "ses_1",
    part: {
      id: `prt_step_${idx}`,
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "step-finish",
      reason: "stop",
      snapshot: "abc",
      cost,
      tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  };
}

describe("opencode message-mapper", () => {
  it("captures the CLI session id from any frame without emitting an event", () => {
    const s = state();
    expect(mapOpenCodeEvent(textFrame("hi"), s)).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(s.sessionId).toBe("ses_1");
  });

  it("maps a text frame to a text delta, because OpenCode sends deltas", () => {
    const s = state();
    expect(mapOpenCodeEvent(textFrame("Hel"), s)).toEqual([{ type: "text_delta", text: "Hel" }]);
    expect(mapOpenCodeEvent(textFrame("lo"), s)).toEqual([{ type: "text_delta", text: "lo" }]);
  });

  it("maps a reasoning frame to a thinking delta", () => {
    const s = state();
    expect(mapOpenCodeEvent(textFrame("Considering.", "reasoning"), s)).toEqual([
      { type: "thinking_delta", text: "Considering." },
    ]);
  });

  it("emits nothing for an empty delta", () => {
    const s = state();
    expect(mapOpenCodeEvent(textFrame(""), s)).toEqual([]);
  });

  it("maps a completed shell call to a Bash start and end pair", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "shell",
        { command: "npm test" },
        {
          status: "completed",
          output: "3 passed",
          title: "shell",
          metadata: {},
          time: { start: 1300, end: 1400 },
        },
      ),
      s,
    );
    expect(out).toEqual([
      {
        type: "tool_start",
        id: "tool_1",
        name: "Bash",
        summary: "npm test",
        input: { command: "npm test" },
        parentToolUseId: null,
      },
      { type: "tool_end", id: "tool_1", ok: true, output: "3 passed" },
    ]);
  });

  it("marks an errored tool as not ok and surfaces the error text", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "shell",
        { command: "false" },
        { status: "error", error: "exit status 1", metadata: {}, time: { start: 1300, end: 1400 } },
      ),
      s,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ type: "tool_end", id: "tool_1", ok: false, output: "exit status 1" });
  });

  it("caps oversized tool output with the neutral truncation mark", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "shell",
        { command: "cat big" },
        {
          status: "completed",
          output: "x".repeat(20_000),
          title: "shell",
          metadata: {},
          time: { start: 1300, end: 1400 },
        },
      ),
      s,
    );
    const end = out[1];
    if (end.type !== "tool_end") throw new Error("expected tool_end");
    expect(end.output.endsWith(OUTPUT_TRUNCATION_MARK)).toBe(true);
    expect(end.output.length).toBeLessThan(20_000);
  });

  it("translates edit's camelCase input to the Claude shape editPreview reads", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "edit",
        { path: "src/a.ts", oldString: "a", newString: "b" },
        {
          status: "completed",
          output: "",
          title: "edit",
          metadata: {},
          time: { start: 1300, end: 1400 },
        },
      ),
      s,
    );
    const start = out[0];
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("Edit");
    expect(start.summary).toBe("src/a.ts");
    expect(start.input).toEqual({ file_path: "src/a.ts", old_string: "a", new_string: "b" });
  });

  it("translates write to Write with a file_path and content", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "write",
        { path: "src/new.ts", content: "export {}" },
        {
          status: "completed",
          output: "",
          title: "write",
          metadata: {},
          time: { start: 1300, end: 1400 },
        },
      ),
      s,
    );
    const start = out[0];
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("Write");
    expect(start.input).toEqual({ file_path: "src/new.ts", content: "export {}" });
  });

  it.each([
    ["read", { path: "a.txt" }, "Read", { file_path: "a.txt" }, "a.txt"],
    ["glob", { pattern: "**/*.ts" }, "Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["grep", { pattern: "TODO" }, "Grep", { pattern: "TODO" }, "TODO"],
    ["webfetch", { url: "https://example.com" }, "WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["websearch", { query: "next 16" }, "WebSearch", { query: "next 16" }, "next 16"],
  ])("translates %s to %s", (tool, input, name, mappedInput, summary) => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(tool, input, {
        status: "completed",
        output: "ok",
        title: tool,
        metadata: {},
        time: { start: 1300, end: 1400 },
      }),
      s,
    );
    const start = out[0];
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe(name);
    expect(start.input).toEqual(mappedInput);
    expect(start.summary).toBe(summary);
  });

  it("passes an unmapped tool name through with a JSON summary instead of inventing one", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      toolFrame(
        "mytool_server_tool",
        { a: 1 },
        {
          status: "completed",
          output: "done",
          title: "mytool_server_tool",
          metadata: {},
          time: { start: 1300, end: 1400 },
        },
      ),
      s,
    );
    const start = out[0];
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("mytool_server_tool");
    expect(start.summary).toBe('{"a":1}');
    expect(start.input).toEqual({ a: 1 });
  });

  it("accumulates cost and tokens across step_finish frames without emitting an event", () => {
    const s = state();
    expect(mapOpenCodeEvent(stepFinish(0.002, 120, 40, 0), s)).toEqual([]);
    expect(mapOpenCodeEvent(stepFinish(0.003, 30, 10, 1), s)).toEqual([]);
    const out = finishOpenCodeTurn(s, "done", null);
    expect(out).toEqual([
      {
        type: "turn_end",
        reason: "done",
        model: "anthropic/claude-sonnet-4",
        durationMs: 500,
        costUsd: 0.005,
        tokens: { input: 150, output: 50 },
        error: null,
      },
    ]);
  });

  it("reports null cost and tokens when no step finished", () => {
    const s = state();
    const out = finishOpenCodeTurn(s, "done", null);
    expect(out[0]).toMatchObject({ costUsd: null, tokens: { input: null, output: null } });
  });

  it("finishes the turn exactly once", () => {
    const s = state();
    expect(finishOpenCodeTurn(s, "done", null)).toHaveLength(1);
    expect(finishOpenCodeTurn(s, "done", null)).toEqual([]);
  });

  it("maps an error frame to one error turn_end", () => {
    const s = state();
    const out = mapOpenCodeEvent(
      {
        type: "error",
        timestamp: 1500,
        sessionID: "ses_1",
        error: { type: "unknown", message: "model overloaded" },
      },
      s,
    );
    expect(out).toHaveLength(1);
    const end = out[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toBe("model overloaded");
    expect(finishOpenCodeTurn(s, "done", null)).toEqual([]);
  });

  it("ignores step_start, background_wait, retry, unknown frames and malformed parts", () => {
    const s = state();
    expect(mapOpenCodeEvent({ type: "step_start", timestamp: 1, sessionID: "s", part: {} }, s)).toEqual([]);
    expect(mapOpenCodeEvent({ type: "background_wait", jobs: [] }, s)).toEqual([]);
    expect(mapOpenCodeEvent({ type: "retry", attempt: 1, error: { message: "x" } }, s)).toEqual([]);
    expect(mapOpenCodeEvent({ type: "something.new" }, s)).toEqual([]);
    expect(mapOpenCodeEvent(null, s)).toEqual([]);
    expect(mapOpenCodeEvent({ type: "text" }, s)).toEqual([]);
    expect(mapOpenCodeEvent({ type: "tool_use", part: { id: "t1" } }, s)).toEqual([]);
  });
});
