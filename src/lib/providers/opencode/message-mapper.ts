import { OUTPUT_TRUNCATION_MARK, type TurnEvent } from "../types";

/**
 * Maps one `opencode run --format json` NDJSON frame (v2.2.6) to zero or more
 * neutral TurnEvents.
 *
 * The stream is friendlier than Codex's: `text` / `reasoning` frames carry
 * DELTAS (OpenCode slices each part against what it already printed), and a
 * tool arrives exactly once, already terminal, as `tool_use` with a `state`
 * of `completed` or `error`. So one frame can legitimately yield both a
 * `tool_start` and its `tool_end`, and `partialText` is genuinely true.
 *
 *   text        → text_delta        (part.text is the delta, not the whole part)
 *   reasoning   → thinking_delta    (only when the run was started with --thinking)
 *   tool_use    → tool_start + tool_end   (see TOOL_TRANSLATIONS)
 *   step_finish → nothing, but accumulates cost/tokens for turn_end
 *   error       → turn_end{reason:"error"} (the CLI also sets exit code 1)
 *
 * Tool names and inputs are translated to Claude's vocabulary, not passed
 * through: the whole UI keys on Claude-shaped names (`ToolBody`'s terminal
 * branch, `editPreview`'s `file_path` / `old_string` / `new_string`). A
 * second name vocabulary would be a second renderer.
 */

/**
 * Per-turn mapping state. Held by the session for as long as the CLI process
 * lives; reset at the start of every `send()`.
 */
export interface OpenCodeTurnState {
  /** Session id echoed on every frame — the resume target (`-s`) for the next turn. */
  sessionId: string | null;
  /** Echoed on turn_end; OpenCode reports the model on session events, not on frames. */
  model: string | null;
  /** Wall clock at send(); turn_end reports the delta. */
  startedAt: number;
  /** Injected clock so duration is testable. */
  now: () => number;
  /** Guard: exactly one turn_end per turn, however many terminal frames. */
  emittedTurnEnd: boolean;
  /** Cost summed across this turn's steps; null until a step_finish reports one. */
  costUsd: number | null;
  /** Tokens summed across this turn's steps; null until a step_finish reports them. */
  tokens: { input: number | null; output: number | null };
}

export function newOpenCodeTurnState(opts: {
  model: string | null;
  startedAt?: number;
  now?: () => number;
}): OpenCodeTurnState {
  return {
    sessionId: null,
    model: opts.model,
    startedAt: opts.startedAt ?? Date.now(),
    now: opts.now ?? Date.now,
    emittedTurnEnd: false,
    costUsd: null,
    tokens: { input: null, output: null },
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

/** One line summarising arbitrary arguments, for tools with no better header. */
function jsonSummary(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (json === "{}") return "";
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

/**
 * How one OpenCode tool becomes a Claude-shaped card: its name, the input the
 * preview/terminal branches read (translated from OpenCode's camelCase), and
 * the header line that identifies the call.
 */
interface ToolTranslation {
  name: string;
  input: (raw: AnyRecord) => Record<string, unknown>;
  summary: (input: Record<string, unknown>, raw: AnyRecord) => string;
}

const TOOL_TRANSLATIONS: Record<string, ToolTranslation> = {
  shell: {
    name: "Bash",
    input: (raw) => ({ command: str(raw["command"]) }),
    summary: (_input, raw) => str(raw["command"]),
  },
  edit: {
    name: "Edit",
    input: (raw) => ({
      file_path: str(raw["path"]),
      old_string: str(raw["oldString"]),
      new_string: str(raw["newString"]),
    }),
    summary: (_input, raw) => str(raw["path"]),
  },
  write: {
    name: "Write",
    input: (raw) => ({ file_path: str(raw["path"]), content: str(raw["content"]) }),
    summary: (_input, raw) => str(raw["path"]),
  },
  read: {
    name: "Read",
    input: (raw) => ({ file_path: str(raw["path"]) }),
    summary: (_input, raw) => str(raw["path"]),
  },
  glob: {
    name: "Glob",
    input: (raw) => ({ pattern: str(raw["pattern"]) }),
    summary: (_input, raw) => str(raw["pattern"]),
  },
  grep: {
    name: "Grep",
    input: (raw) => ({ pattern: str(raw["pattern"]) }),
    summary: (_input, raw) => str(raw["pattern"]),
  },
  webfetch: {
    name: "WebFetch",
    input: (raw) => ({ url: str(raw["url"]) }),
    summary: (_input, raw) => str(raw["url"]),
  },
  websearch: {
    name: "WebSearch",
    input: (raw) => ({ query: str(raw["query"]) }),
    summary: (_input, raw) => str(raw["query"]),
  },
};

/**
 * RULING — MCP names are passed through untranslated.
 *
 * OpenCode names an MCP tool `${namespace.replaceAll(".","_")}_${name}`, a
 * single underscore. Claude's cards use `mcp__server__tool`. Splitting on the
 * first underscore cannot round-trip (`my_server_tool` is server `my` + tool
 * `server_tool`, or server `my_server` + tool `tool` — both are legal), and a
 * card that confidently shows the WRONG server is worse than one showing an
 * unfamiliar name with generic arguments. Cost if wrong: an MCP card renders
 * with the fallback icon and its raw input as JSON, which the UI already
 * handles for unknown tools.
 */
function translateTool(toolName: string): ToolTranslation {
  return (
    TOOL_TRANSLATIONS[toolName] ?? {
      // A tool we do not know (a plugin, a newer built-in) keeps its own name
      // and its raw input: better an honest unfamiliar card than a wrong one.
      name: toolName || "tool",
      input: (raw) => raw,
      summary: (input) => jsonSummary(input),
    }
  );
}

function toolEvents(part: AnyRecord): TurnEvent[] {
  const id = str(part["id"]);
  const toolName = str(part["tool"]);
  const toolState = isRecord(part["state"]) ? part["state"] : null;
  if (!id || !toolState) return [];

  const rawInput = isRecord(toolState["input"]) ? toolState["input"] : {};
  const translation = TOOL_TRANSLATIONS[toolName] ?? translateTool(toolName);
  const input = translation.input(rawInput);
  const summary = translation.summary(input, rawInput);

  const completed = str(toolState["status"]) === "completed";
  const name = translation.name;

  const output = completed
    ? capOutput(str(toolState["output"]))
    : capOutput(str(toolState["error"], "tool failed"));

  return [
    { type: "tool_start", id, name, summary, input, parentToolUseId: null },
    { type: "tool_end", id, ok: completed, output },
  ];
}

/** Fold one step_finish's cost/tokens into the turn's totals. */
function accumulateStep(part: AnyRecord, state: OpenCodeTurnState): void {
  const cost = num(part["cost"]);
  if (cost !== null) state.costUsd = (state.costUsd ?? 0) + cost;

  const tokens = isRecord(part["tokens"]) ? part["tokens"] : null;
  if (!tokens) return;
  const add = (prev: number | null, next: number | null): number | null =>
    next === null ? prev : (prev ?? 0) + next;
  state.tokens = {
    input: add(state.tokens.input, num(tokens["input"])),
    output: add(state.tokens.output, num(tokens["output"])),
  };
}

/**
 * The turn's terminal event. Called when the process exits cleanly, when an
 * `error` frame arrives, and by the session on interrupt — the once-guard
 * makes whichever comes first authoritative.
 */
export function finishOpenCodeTurn(
  state: OpenCodeTurnState,
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
      costUsd: state.costUsd,
      tokens: state.tokens,
      error,
    },
  ];
}

export function mapOpenCodeEvent(raw: unknown, state: OpenCodeTurnState): TurnEvent[] {
  const frame = isRecord(raw) ? raw : null;
  if (!frame) return [];

  // Every frame carries the session id; remembering it is how the next turn
  // resumes (`-s <id>`), and it costs nothing to do it on all of them.
  const sessionId = str(frame["sessionID"]);
  if (sessionId) state.sessionId = sessionId;

  const type = str(frame["type"]);
  const part = isRecord(frame["part"]) ? frame["part"] : null;

  switch (type) {
    case "text":
    case "reasoning": {
      const text = part ? str(part["text"]) : "";
      if (!text) return [];
      return [{ type: type === "text" ? "text_delta" : "thinking_delta", text }];
    }

    case "tool_use":
      return part ? toolEvents(part) : [];

    case "step_finish": {
      if (part) accumulateStep(part, state);
      return [];
    }

    case "error": {
      const error = isRecord(frame["error"]) ? frame["error"] : null;
      const message = error ? str(error["message"], "stream error") : "stream error";
      return finishOpenCodeTurn(state, "error", message || "stream error");
    }

    // step_start, background_wait, retry, and anything a newer CLI adds:
    // never throw on a live turn.
    default:
      return [];
  }
}
