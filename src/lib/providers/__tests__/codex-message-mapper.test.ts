import { describe, it, expect } from "vitest";
import { mapThreadEvent, newCodexTurnState } from "../codex/message-mapper";
import { OUTPUT_TRUNCATION_MARK } from "../types";

/**
 * Fixtures are shaped exactly like `codex exec --experimental-json` lines.
 * The mapper takes unknown JSON so a newer CLI's extra fields are ignored
 * rather than crashing a live turn.
 */

function state() {
  return newCodexTurnState({ model: "gpt-5-codex", startedAt: 1000, now: () => 1500 });
}

describe("codex message-mapper", () => {
  it("captures the thread id from thread.started without emitting an event", () => {
    const s = state();
    const out = mapThreadEvent({ type: "thread.started", thread_id: "th-1" }, s);
    expect(out).toEqual([]);
    expect(s.threadId).toBe("th-1");
  });

  it("maps a command execution to a Bash tool call", () => {
    const s = state();
    const started = mapThreadEvent(
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      s,
    );
    expect(started).toEqual([
      {
        type: "tool_start",
        id: "item_1",
        name: "Bash",
        summary: "npm test",
        input: { command: "npm test" },
        parentToolUseId: null,
      },
    ]);

    const completed = mapThreadEvent(
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "3 passed",
          exit_code: 0,
          status: "completed",
        },
      },
      s,
    );
    expect(completed).toEqual([
      { type: "tool_end", id: "item_1", ok: true, output: "3 passed" },
    ]);
  });

  it("marks a failed command as not ok", () => {
    const s = state();
    const out = mapThreadEvent(
      {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "false",
          aggregated_output: "boom",
          exit_code: 1,
          status: "failed",
        },
      },
      s,
    );
    expect(out).toEqual([{ type: "tool_end", id: "item_2", ok: false, output: "boom" }]);
  });

  it("caps oversized command output with the neutral truncation mark", () => {
    const s = state();
    const out = mapThreadEvent(
      {
        type: "item.completed",
        item: {
          id: "item_3",
          type: "command_execution",
          command: "cat big",
          aggregated_output: "x".repeat(20_000),
          exit_code: 0,
          status: "completed",
        },
      },
      s,
    );
    const end = out[0];
    expect(end.type).toBe("tool_end");
    if (end.type !== "tool_end") throw new Error("expected tool_end");
    expect(end.output.endsWith(OUTPUT_TRUNCATION_MARK)).toBe(true);
    expect(end.output.length).toBeLessThan(20_000);
  });

  it("maps a file change to an Edit tool call listing every path", () => {
    const s = state();
    const started = mapThreadEvent(
      {
        type: "item.started",
        item: {
          id: "item_4",
          type: "file_change",
          changes: [
            { path: "src/a.ts", kind: "update" },
            { path: "src/b.ts", kind: "add" },
          ],
          status: "completed",
        },
      },
      s,
    );
    expect(started).toHaveLength(1);
    const start = started[0];
    expect(start.type).toBe("tool_start");
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("Edit");
    expect(start.id).toBe("item_4");
    expect(start.summary).toContain("src/a.ts");
    expect(start.summary).toContain("src/b.ts");
    expect(start.input).toMatchObject({ file_path: "src/a.ts" });

    const completed = mapThreadEvent(
      {
        type: "item.completed",
        item: {
          id: "item_4",
          type: "file_change",
          changes: [
            { path: "src/a.ts", kind: "update" },
            { path: "src/b.ts", kind: "add" },
          ],
          status: "failed",
        },
      },
      s,
    );
    expect(completed[0].type).toBe("tool_end");
    if (completed[0].type !== "tool_end") throw new Error("expected tool_end");
    expect(completed[0].ok).toBe(false);
    expect(completed[0].output).toContain("src/a.ts");
  });

  it("names an MCP call with Claude's mcp__server__tool convention", () => {
    const s = state();
    const started = mapThreadEvent(
      {
        type: "item.started",
        item: {
          id: "item_5",
          type: "mcp_tool_call",
          server: "fs",
          tool: "read_file",
          arguments: { path: "a.txt" },
          status: "in_progress",
        },
      },
      s,
    );
    const start = started[0];
    expect(start.type).toBe("tool_start");
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("mcp__fs__read_file");
    expect(start.summary).toBe('{"path":"a.txt"}');
    expect(start.input).toEqual({ path: "a.txt" });

    const completed = mapThreadEvent(
      {
        type: "item.completed",
        item: {
          id: "item_5",
          type: "mcp_tool_call",
          server: "fs",
          tool: "read_file",
          arguments: { path: "a.txt" },
          result: { content: [], structured_content: { ok: true } },
          status: "completed",
        },
      },
      s,
    );
    const end = completed[0];
    expect(end.type).toBe("tool_end");
    if (end.type !== "tool_end") throw new Error("expected tool_end");
    expect(end.ok).toBe(true);
    expect(end.output).toContain("ok");
  });

  it("maps a web search to a WebSearch tool call", () => {
    const s = state();
    const started = mapThreadEvent(
      {
        type: "item.started",
        item: { id: "item_6", type: "web_search", query: "next.js 16 docs" },
      },
      s,
    );
    const start = started[0];
    expect(start.type).toBe("tool_start");
    if (start.type !== "tool_start") throw new Error("expected tool_start");
    expect(start.name).toBe("WebSearch");
    expect(start.summary).toBe("next.js 16 docs");

    const completed = mapThreadEvent(
      {
        type: "item.completed",
        item: { id: "item_6", type: "web_search", query: "next.js 16 docs" },
      },
      s,
    );
    expect(completed).toEqual([{ type: "tool_end", id: "item_6", ok: true, output: "" }]);
  });

  it("emits an agent message once, on completion, since Codex streams no deltas", () => {
    const s = state();
    const item = { id: "item_7", type: "agent_message", text: "All done." };
    expect(mapThreadEvent({ type: "item.started", item }, s)).toEqual([]);
    expect(mapThreadEvent({ type: "item.updated", item }, s)).toEqual([]);
    expect(mapThreadEvent({ type: "item.completed", item }, s)).toEqual([
      { type: "text_delta", text: "All done." },
    ]);
  });

  it("maps reasoning to a thinking delta on completion", () => {
    const s = state();
    const item = { id: "item_8", type: "reasoning", text: "Considering options." };
    expect(mapThreadEvent({ type: "item.started", item }, s)).toEqual([]);
    expect(mapThreadEvent({ type: "item.completed", item }, s)).toEqual([
      { type: "thinking_delta", text: "Considering options." },
    ]);
  });

  it("emits exactly one done turn_end with usage tokens", () => {
    const s = state();
    const out = mapThreadEvent(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 100,
          cache_write_input_tokens: 0,
          output_tokens: 40,
          reasoning_output_tokens: 5,
        },
      },
      s,
    );
    expect(out).toEqual([
      {
        type: "turn_end",
        reason: "done",
        model: "gpt-5-codex",
        durationMs: 500,
        costUsd: null,
        tokens: { input: 120, output: 40 },
        error: null,
      },
    ]);
    expect(mapThreadEvent({ type: "turn.completed", usage: {} }, s)).toEqual([]);
  });

  it("maps turn.failed to one error turn_end", () => {
    const s = state();
    const out = mapThreadEvent(
      { type: "turn.failed", error: { message: "model overloaded" } },
      s,
    );
    expect(out).toHaveLength(1);
    const end = out[0];
    expect(end.type).toBe("turn_end");
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toBe("model overloaded");
    expect(mapThreadEvent({ type: "turn.failed", error: { message: "again" } }, s)).toEqual([]);
  });

  it("maps a stream-level error frame to an error turn_end", () => {
    const s = state();
    const out = mapThreadEvent({ type: "error", message: "connection reset" }, s);
    expect(out).toHaveLength(1);
    const end = out[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toBe("connection reset");
  });

  it("ignores unknown frames and malformed items", () => {
    const s = state();
    expect(mapThreadEvent({ type: "turn.started" }, s)).toEqual([]);
    expect(mapThreadEvent({ type: "something.new" }, s)).toEqual([]);
    expect(mapThreadEvent(null, s)).toEqual([]);
    expect(mapThreadEvent({ type: "item.completed", item: { type: "unknown_item" } }, s)).toEqual(
      [],
    );
  });
});
