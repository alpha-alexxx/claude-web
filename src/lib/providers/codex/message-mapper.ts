import { OUTPUT_TRUNCATION_MARK, type TurnEvent } from "../types";

/**
 * Maps one `codex exec --experimental-json` event to zero or more neutral
 * TurnEvents.
 *
 * Codex speaks a coarser protocol than the Claude SDK: there are no text
 * deltas, an item's payload arrives complete on `item.started`, and its
 * terminal state arrives on `item.completed`. So the adapter chooses the
 * stream's nearest equivalent (§ capabilities: partialText false):
 *
 *   agent_message / reasoning  → text/thinking block, emitted on COMPLETION
 *                                (item.started carries the same full text;
 *                                emitting there would double every message)
 *   command_execution          → tool_start("Bash")  … tool_end ok = exit_code 0
 *   file_change                → tool_start("Edit")  … tool_end ok = status
 *   mcp_tool_call              → mcp__server__tool  (Claude's naming, so the
 *                                card/preview code paths are shared)
 *   web_search                 → WebSearch
 *   todo_list / error item     → ignored (the plan renders as chat text)
 *
 * Tool names are translated, not passed through, because the whole UI keys
 * on Claude-shaped names (`ToolBody`'s terminal branch, `editPreview`). A
 * second name vocabulary would be a second renderer.
 */

/**
 * Per-turn mapping state. Held by the session for as long as the CLI process
 * lives; reset at the start of every `send()`.
 */
export interface CodexTurnState {
  /** Thread id from `thread.started` — the resume target for the next turn. */
  threadId: string | null;
  /** Echoed on turn_end; Codex has no per-turn model frame. */
  model: string | null;
  /** Wall clock at send(); turn_end reports the delta. */
  startedAt: number;
  /** Injected clock so duration is testable. */
  now: () => number;
  /** Guard: exactly one turn_end per turn, however many terminal frames. */
  emittedTurnEnd: boolean;
}

export function newCodexTurnState(opts: {
  model: string | null;
  startedAt?: number;
  now?: () => number;
}): CodexTurnState {
  return {
    threadId: null,
    model: opts.model,
    startedAt: opts.startedAt ?? Date.now(),
    now: opts.now ?? Date.now,
    emittedTurnEnd: false,
  };
}

/**
 * Same cap and same visible marker as the Claude adapter: the UI tests for
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

/** Parse a JSON string argument blob; anything unparseable becomes {}. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Tool arguments that are not JSON (a bare string) still deserve a card.
    }
    return { arguments: raw };
  }
  return {};
}

/** Compress an arbitrary argument object to one header line. */
function jsonSummary(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (json === "{}") return "";
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

function commandItem(item: AnyRecord, phase: "start" | "end"): TurnEvent[] {
  const id = str(item["id"]);
  const command = str(item["command"]);
  if (phase === "start") {
    return [
      {
        type: "tool_start",
        id,
        name: "Bash",
        summary: command,
        input: { command },
        parentToolUseId: null,
      },
    ];
  }
  const exitCode = typeof item["exit_code"] === "number" ? item["exit_code"] : null;
  const status = str(item["status"]);
  // exit_code is authoritative when present (a command can end "completed"
  // with a nonzero code only if the CLI ever reports that); status is the
  // fallback for items the CLI never gave a code.
  const ok = exitCode !== null ? exitCode === 0 : status === "completed";
  return [
    {
      type: "tool_end",
      id,
      ok,
      output: capOutput(str(item["aggregated_output"])),
    },
  ];
}

function fileChangeItem(item: AnyRecord, phase: "start" | "end"): TurnEvent[] {
  const id = str(item["id"]);
  const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
  const paths = changes
    .map((c) => (isRecord(c) ? str(c["path"]) : ""))
    .filter((p) => p.length > 0);
  const input: Record<string, unknown> = paths.length > 0 ? { file_path: paths[0] } : {};
  if (phase === "start") {
    return [
      {
        type: "tool_start",
        id,
        name: "Edit",
        summary: paths.join(", "),
        input,
        parentToolUseId: null,
      },
    ];
  }
  const ok = str(item["status"]) !== "failed";
  return [
    {
      type: "tool_end",
      id,
      ok,
      output: capOutput(paths.length > 0 ? `changed ${paths.join(", ")}` : "no file changes"),
    },
  ];
}

function mcpItem(item: AnyRecord, phase: "start" | "end"): TurnEvent[] {
  const id = str(item["id"]);
  const name = `mcp__${str(item["server"], "mcp")}__${str(item["tool"], "tool")}`;
  const input = parseArgs(item["arguments"]);
  if (phase === "start") {
    return [
      {
        type: "tool_start",
        id,
        name,
        summary: jsonSummary(input),
        input,
        parentToolUseId: null,
      },
    ];
  }
  const error = isRecord(item["error"]) ? str(item["error"]["message"]) : "";
  const result = item["result"];
  let output = error;
  if (!output && isRecord(result)) {
    const structured = result["structured_content"];
    if (structured !== undefined) output = JSON.stringify(structured);
    else if (Array.isArray(result["content"])) {
      output = result["content"]
        .map((b) => (isRecord(b) && typeof b["text"] === "string" ? b["text"] : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  const ok = str(item["status"]) !== "failed" && error.length === 0;
  return [{ type: "tool_end", id, ok, output: capOutput(output) }];
}

function webSearchItem(item: AnyRecord, phase: "start" | "end"): TurnEvent[] {
  const id = str(item["id"]);
  const query = str(item["query"]);
  if (phase === "start") {
    return [
      {
        type: "tool_start",
        id,
        name: "WebSearch",
        summary: query,
        input: { query },
        parentToolUseId: null,
      },
    ];
  }
  // The completed item carries no results; the agent's own message does.
  return [{ type: "tool_end", id, ok: true, output: "" }];
}

function itemEvent(item: AnyRecord, phase: "start" | "end"): TurnEvent[] {
  const type = str(item["type"]);
  if (type === "command_execution") return commandItem(item, phase);
  if (type === "file_change") return fileChangeItem(item, phase);
  if (type === "mcp_tool_call") return mcpItem(item, phase);
  if (type === "web_search") return webSearchItem(item, phase);
  if (type === "agent_message" && phase === "end") {
    const text = str(item["text"]);
    return text ? [{ type: "text_delta", text }] : [];
  }
  if (type === "reasoning" && phase === "end") {
    const text = str(item["text"]);
    return text ? [{ type: "thinking_delta", text }] : [];
  }
  // todo_list renders as assistant prose in the agent message; the error item
  // is the stream's own non-fatal warning, not a failed tool.
  return [];
}

function endTurn(
  state: CodexTurnState,
  reason: "done" | "error",
  tokens: { input: number | null; output: number | null },
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
      // Codex reports tokens but not a per-turn price; inventing one from a
      // price table would drift from the account's actual billing.
      costUsd: null,
      tokens,
      error,
    },
  ];
}

export function mapThreadEvent(raw: unknown, state: CodexTurnState): TurnEvent[] {
  const evt = isRecord(raw) ? raw : null;
  if (!evt) return [];

  switch (str(evt["type"])) {
    case "thread.started": {
      const id = str(evt["thread_id"]);
      if (id) state.threadId = id;
      return [];
    }

    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = isRecord(evt["item"]) ? evt["item"] : null;
      if (!item) return [];
      const phase = str(evt["type"]) === "item.completed" ? "end" : "start";
      return itemEvent(item, phase);
    }

    case "turn.completed": {
      const usage = isRecord(evt["usage"]) ? evt["usage"] : {};
      const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
      return endTurn(
        state,
        "done",
        { input: num(usage["input_tokens"]), output: num(usage["output_tokens"]) },
        null,
      );
    }

    case "turn.failed": {
      const error = isRecord(evt["error"]) ? str(evt["error"]["message"]) : "";
      return endTurn(state, "error", { input: null, output: null }, error || "turn failed");
    }

    case "error": {
      return endTurn(
        state,
        "error",
        { input: null, output: null },
        str(evt["message"], "stream error") || "stream error",
      );
    }

    // turn.started and anything a newer CLI adds: never throw on a live turn.
    default:
      return [];
  }
}
