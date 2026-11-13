import { OUTPUT_TRUNCATION_MARK, type TurnEvent } from "../types";

/**
 * Maps one `qoder --print --output-format stream-json` frame (qodercli 1.1.86)
 * to zero or more neutral TurnEvents.
 *
 * Qoder speaks Claude's stream-json dialect: `stream_event` deltas,
 * per-content-block `assistant` frames, `user` frames carrying `tool_result`,
 * and a terminal `result` — all with `session_id` and `parent_tool_use_id`.
 * So unlike the Codex and OpenCode mappers this one has NO tool-name
 * translation table: the names are already `Bash` / `Edit` / `Read`, which is
 * exactly the vocabulary the UI keys on.
 *
 * Two facts from the CLI's bundle shape the mapping:
 *
 *   1. `--include-partial-messages` must be on for `stream_event` frames to
 *      be emitted at all, so `partial` is always true here and a complete
 *      `assistant` frame must not re-emit text the deltas already delivered.
 *   2. `total_cost_usd` is hardcoded to 0 and the real usage figure is
 *      `total_credits`, which is not dollars. `turn_end.costUsd` is therefore
 *      always null ("unknown"), never 0 — 0 would render the turn as free.
 */

export interface QoderTurnState {
  /** Session id echoed on frames — the resume target (`--resume`) next turn. */
  sessionId: string | null;
  /** Model reported by assistant frames, for turn_end. */
  model: string | null;
  /** Wall clock at send(); turn_end reports the delta. */
  startedAt: number;
  /** Injected clock so duration is testable. */
  now: () => number;
  /** Guard: exactly one turn_end per turn, however many terminal frames. */
  emittedTurnEnd: boolean;
  /** tool_use ids whose tool_start was already emitted. */
  seenToolIds: Set<string>;
  /** Block index → assembling tool block from partial input_json_delta. */
  openTools: Map<number, { id: string; name: string; jsonBuf: string[] }>;
}

export function newQoderTurnState(opts: {
  model: string | null;
  startedAt?: number;
  now?: () => number;
}): QoderTurnState {
  return {
    sessionId: null,
    model: opts.model,
    startedAt: opts.startedAt ?? Date.now(),
    now: opts.now ?? Date.now,
    emittedTurnEnd: false,
    seenToolIds: new Set(),
    openTools: new Map(),
  };
}

/**
 * Same cap and same visible marker as every other adapter: the UI tests for
 * the marker, so clipping silently here would render as a complete result
 * that merely ends mid-sentence.
 */
const MAX_TOOL_OUTPUT_CHARS = 12_000;

function capOutput(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) + OUTPUT_TRUNCATION_MARK
    : text;
}

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === "object" && v !== null;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** One-line, tool-neutral preview for the card header (same keys as Claude's). */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return null;
  };
  const perTool: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path", "path"],
    Write: ["file_path", "path"],
    Edit: ["file_path", "path"],
    Glob: ["pattern"],
    Grep: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["prompt", "description"],
  };
  const keys = perTool[name] ?? ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"];
  for (const k of keys) {
    const got = first(input[k]);
    if (got !== null) return got;
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

/** Concatenate a tool_result content block (string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) ? str(b["text"]) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The turn's terminal event. Called on the `result` frame, when the process
 * fails without one, and by the session on interrupt — the once-guard makes
 * whichever comes first authoritative.
 */
export function finishQoderTurn(
  state: QoderTurnState,
  reason: "done" | "error" | "interrupted",
  error: string | null,
): TurnEvent[] {
  if (state.emittedTurnEnd) return [];
  state.emittedTurnEnd = true;
  return [
    {
      type: "turn_end",
      reason,
      model: state.model,
      durationMs: Math.max(0, state.now() - state.startedAt),
      // Never the CLI's total_cost_usd: it is hardcoded 0.
      costUsd: null,
      tokens: { input: null, output: null },
      error,
    },
  ];
}

function handleStreamEvent(evt: AnyRecord, state: QoderTurnState): TurnEvent[] {
  const etype = evt["type"];

  if (etype === "content_block_start") {
    const block = isRecord(evt["content_block"]) ? evt["content_block"] : null;
    if (block && block["type"] === "tool_use") {
      const index = num(evt["index"]) ?? -1;
      state.openTools.set(index, {
        id: str(block["id"]),
        name: str(block["name"], "tool"),
        jsonBuf: [],
      });
    }
    return [];
  }

  if (etype === "content_block_delta") {
    const delta = isRecord(evt["delta"]) ? evt["delta"] : null;
    if (!delta) return [];
    switch (delta["type"]) {
      case "text_delta": {
        const text = str(delta["text"]);
        return text ? [{ type: "text_delta", text }] : [];
      }
      case "thinking_delta": {
        const text = str(delta["thinking"]);
        return text ? [{ type: "thinking_delta", text }] : [];
      }
      case "input_json_delta": {
        const index = num(evt["index"]) ?? -1;
        const pending = state.openTools.get(index);
        if (pending) pending.jsonBuf.push(str(delta["partial_json"]));
        return [];
      }
      default:
        return [];
    }
  }

  if (etype === "content_block_stop") {
    const index = num(evt["index"]) ?? -1;
    const pending = state.openTools.get(index);
    if (pending) state.openTools.delete(index);
    if (!pending) return [];
    if (pending.id) state.seenToolIds.add(pending.id);
    const raw = pending.jsonBuf.join("");
    let input: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) input = parsed;
      } catch {
        // truncated buffer — an empty card beats a broken turn
      }
    }
    return [
      {
        type: "tool_start",
        id: pending.id,
        name: pending.name,
        summary: toolSummary(pending.name, input),
        input,
        parentToolUseId: null,
      },
    ];
  }

  return [];
}

function assistantEvents(frame: AnyRecord, state: QoderTurnState): TurnEvent[] {
  const message = isRecord(frame["message"]) ? frame["message"] : null;
  if (!message) return [];
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const parent = typeof frame["parent_tool_use_id"] === "string" ? frame["parent_tool_use_id"] : null;
  const model = str(message["model"]);
  if (model) state.model = model;

  const out: TurnEvent[] = [];
  for (const raw of content) {
    const block = isRecord(raw) ? raw : null;
    if (!block) continue;
    if (block["type"] === "tool_use") {
      const id = str(block["id"]);
      if (id && state.seenToolIds.has(id)) continue; // the deltas already emitted it
      if (id) state.seenToolIds.add(id);
      const name = str(block["name"], "tool");
      const input = isRecord(block["input"]) ? block["input"] : {};
      out.push({ type: "tool_start", id, name, summary: toolSummary(name, input), input, parentToolUseId: parent });
    }
    // Text and thinking always arrive as deltas first (the run turns on
    // --include-partial-messages), so a complete block must not repeat them.
  }
  return out;
}

function userEvents(frame: AnyRecord): TurnEvent[] {
  const message = isRecord(frame["message"]) ? frame["message"] : null;
  if (!message) return [];
  const content = Array.isArray(message["content"]) ? message["content"] : [];
  const out: TurnEvent[] = [];
  for (const raw of content) {
    const block = isRecord(raw) ? raw : null;
    if (!block || block["type"] !== "tool_result") continue;
    out.push({
      type: "tool_end",
      id: str(block["tool_use_id"]),
      ok: block["is_error"] !== true,
      output: capOutput(resultText(block["content"])),
    });
  }
  return out;
}

function resultEvents(frame: AnyRecord, state: QoderTurnState): TurnEvent[] {
  if (state.emittedTurnEnd) return [];
  state.emittedTurnEnd = true;

  const usage = isRecord(frame["usage"]) ? frame["usage"] : {};
  const subtype = str(frame["subtype"]);
  const isError = frame["is_error"] === true || (subtype !== "" && subtype !== "success");
  const errors = Array.isArray(frame["errors"])
    ? frame["errors"].filter((e): e is string => typeof e === "string")
    : [];
  const errorText = isError
    ? (errors[0] ?? str(frame["result"], "turn failed") ?? "turn failed")
    : null;

  return [
    {
      type: "turn_end",
      reason: isError ? "error" : "done",
      model: state.model,
      durationMs: num(frame["duration_ms"]) ?? Math.max(0, state.now() - state.startedAt),
      // total_cost_usd is hardcoded 0 by the CLI; total_credits is not money.
      costUsd: null,
      tokens: { input: num(usage["input_tokens"]), output: num(usage["output_tokens"]) },
      error: errorText,
    },
  ];
}

export function mapQoderFrame(raw: unknown, state: QoderTurnState): TurnEvent[] {
  const frame = isRecord(raw) ? raw : null;
  if (!frame) return [];

  // Every frame may carry the session id; remembering it is how the next turn
  // resumes, and it costs nothing to try on all of them.
  const sessionId = str(frame["session_id"]);
  if (sessionId) state.sessionId = sessionId;

  switch (str(frame["type"])) {
    case "stream_event": {
      const evt = isRecord(frame["event"]) ? frame["event"] : null;
      return evt ? handleStreamEvent(evt, state) : [];
    }
    case "assistant":
      return assistantEvents(frame, state);
    case "user":
      return userEvents(frame);
    case "result":
      return resultEvents(frame, state);
    // system / assistant_block / command_lifecycle / attachment and anything
    // a newer CLI adds: ignored, never thrown — a live turn must not break.
    default:
      return [];
  }
}
