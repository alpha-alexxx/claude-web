import { describe, it, expect } from "vitest";
import {
  finishQoderTurn,
  mapQoderFrame,
  newQoderTurnState,
  type QoderTurnState,
} from "../qoder/message-mapper";
import { OUTPUT_TRUNCATION_MARK } from "../types";

/**
 * Qoder's stream-json frames are the same dialect the Claude SDK emits —
 * `stream_event` deltas, per-block `assistant` frames, `user` frames carrying
 * `tool_result`, and a terminal `result`. So this mapper is deliberately
 * narrower than Codex's or OpenCode's: it does NOT translate tool names
 * (they are already `Bash`/`Edit`/`Read`), and it reads the same fields the
 * Claude mapper reads.
 *
 * The one place it is NOT Claude's mapper: `total_cost_usd` is hardcoded 0
 * in qodercli and the real usage figure is `total_credits`, which is not
 * dollars. Reporting 0 would render every turn as free.
 */

function state(): QoderTurnState {
  return newQoderTurnState({ model: null });
}

describe("qoder message mapper", () => {
  it("maps stream_event text and thinking deltas", () => {
    const s = state();
    expect(
      mapQoderFrame(
        {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        },
        s,
      ),
    ).toEqual([{ type: "text_delta", text: "hi" }]);
    expect(
      mapQoderFrame(
        {
          type: "stream_event",
          event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
        },
        s,
      ),
    ).toEqual([{ type: "thinking_delta", text: "hmm" }]);
  });

  it("assembles a tool call from a partial input_json_delta stream", () => {
    const s = state();
    expect(
      mapQoderFrame(
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "Bash", input: {} },
          },
        },
        s,
      ),
    ).toEqual([]);
    mapQoderFrame(
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls' },
        },
      },
      s,
    );
    mapQoderFrame(
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' -la"}' } },
      },
      s,
    );
    expect(
      mapQoderFrame(
        { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
        s,
      ),
    ).toEqual([
      {
        type: "tool_start",
        id: "tu_1",
        name: "Bash",
        summary: "ls -la",
        input: { command: "ls -la" },
        parentToolUseId: null,
      },
    ]);
  });

  it("does not re-emit a tool whose start already came from the stream", () => {
    const s = state();
    mapQoderFrame(
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} } },
      },
      s,
    );
    mapQoderFrame({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }, s);
    expect(
      mapQoderFrame(
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "qwen3.8-max",
            content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/a.ts" } }],
          },
          parent_tool_use_id: null,
        },
        s,
      ),
    ).toEqual([]);
    expect(s.model).toBe("qwen3.8-max");
  });

  it("emits a parent_tool_use_id for a subagent's tool call", () => {
    const s = state();
    const out = mapQoderFrame(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_2", name: "Task", input: { prompt: "dig" } }],
        },
        parent_tool_use_id: "tu_parent",
      },
      s,
    );
    expect(out).toEqual([
      {
        type: "tool_start",
        id: "tu_2",
        name: "Task",
        summary: "dig",
        input: { prompt: "dig" },
        parentToolUseId: "tu_parent",
      },
    ]);
  });

  it("maps a tool_result user frame to tool_end, capped with the visible marker", () => {
    const s = state();
    const huge = "x".repeat(13_000);
    const out = mapQoderFrame(
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: huge }] } },
      s,
    );
    expect(out).toHaveLength(1);
    const end = out[0];
    if (end.type !== "tool_end") throw new Error("expected tool_end");
    expect(end.id).toBe("tu_1");
    expect(end.ok).toBe(true);
    expect(end.output.endsWith(OUTPUT_TRUNCATION_MARK)).toBe(true);
    expect(end.output.length).toBeLessThan(huge.length);
  });

  it("maps a result frame to turn_end exactly once and reports cost as unknown", () => {
    const s = state();
    const frame = {
      type: "result",
      subtype: "success",
      duration_ms: 900,
      is_error: false,
      total_cost_usd: 0,
      total_credits: 4,
      usage: { input_tokens: 7, output_tokens: 3 },
      session_id: "qses_1",
    };
    const out = mapQoderFrame(frame, s);
    expect(out).toHaveLength(1);
    const end = out[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("done");
    expect(end.durationMs).toBe(900);
    expect(end.tokens).toEqual({ input: 7, output: 3 });
    expect(end.costUsd).toBeNull();
    // A second terminal frame must not double-end the turn.
    expect(mapQoderFrame(frame, s)).toEqual([]);
    expect(finishQoderTurn(s, "done", null)).toEqual([]);
  });

  it("reports an error result frame as an error turn_end carrying its first message", () => {
    const s = state();
    const out = mapQoderFrame(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        total_cost_usd: 0,
        errors: ["rate limited"],
        usage: {},
        session_id: "qses_1",
      },
      s,
    );
    const end = out[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.reason).toBe("error");
    expect(end.error).toBe("rate limited");
  });

  it("takes the session id from every frame that carries one", () => {
    const s = state();
    mapQoderFrame({ type: "system", subtype: "init", session_id: "qses_7" }, s);
    expect(s.sessionId).toBe("qses_7");
    mapQoderFrame({ type: "stream_event", event: { type: "message_stop" }, session_id: "qses_8" }, s);
    expect(s.sessionId).toBe("qses_8");
  });

  it("ignores frames it does not know, and never throws", () => {
    const s = state();
    expect(mapQoderFrame({ type: "mystery" }, s)).toEqual([]);
    expect(mapQoderFrame(null, s)).toEqual([]);
    expect(mapQoderFrame("nonsense", s)).toEqual([]);
  });

  it("finishes a turn the CLI never framed, using the injected clock", () => {
    const s = newQoderTurnState({ model: "qwen3.8-max", startedAt: 1_000, now: () => 3_500 });
    const out = finishQoderTurn(s, "done", null);
    expect(out).toHaveLength(1);
    const end = out[0];
    if (end.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.model).toBe("qwen3.8-max");
    expect(end.durationMs).toBe(2_500);
    expect(end.costUsd).toBeNull();
  });
});
