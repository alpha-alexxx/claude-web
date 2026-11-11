import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TurnEvent } from "../types";

/**
 * Maps one SDK message (from Query's AsyncGenerator) to zero or more neutral
 * TurnEvents. Mirrors the legacy Python app's stream mapping (parity
 * reference: pump handlers for stream_event / assistant / user / result),
 * now typed against the SDK's own message union.
 *
 * The mapping is stateful per turn: stream events open/assemble tool blocks
 * by index, and result messages must not double-emit turn_end. Each active
 * conversation holds one TurnState.
 */

export interface TurnState {
  /** tool_use ids whose tool_start was already emitted (partial or full). */
  seenToolIds: Set<string>;
  /** block index → assembling tool block from partial input_json_delta. */
  openTools: Map<number, { id: string; name: string; jsonBuf: string[] }>;
  /** Model of the current turn (from assistant messages), for turn_end. */
  model: string | null;
  /** Guard: exactly one turn_end per result/pump (legacy parity). */
  emittedTurnEnd: boolean;
  /**
   * True when the CLI streams partial deltas (includePartialMessages). In
   * that mode the complete assistant message still arrives after the deltas;
   * its text/thinking blocks must NOT be re-emitted (the deltas own them).
   * In non-partial mode, full messages are the only text source.
   */
  partial: boolean;
}

export function newTurnState(opts?: { partial: boolean }): TurnState {
  return {
    seenToolIds: new Set(),
    openTools: new Map(),
    model: null,
    emittedTurnEnd: false,
    // Default partial: the session pool always runs with
    // includePartialMessages: true, so deltas own the text and the full
    // assistant message must not re-emit its text/thinking blocks.
    partial: opts?.partial ?? true,
  };
}

const MAX_TOOL_OUTPUT_CHARS = 12_000;

/** One-line, tool-neutral preview of a tool call for the UI card header. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v) && v.length > 0) {
      // AskUserQuestion: first question's question text
      const q = v[0];
      if (q && typeof q === "object" && "question" in q) {
        const text = (q as { question?: unknown }).question;
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
    return null;
  };
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const got = first(input[k]);
      if (got !== null) return got;
    }
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
    TodoWrite: ["todos"],
    AskUserQuestion: ["questions"],
  };
  const keys = perTool[name] ?? ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"];
  const found = pick(keys);
  if (found !== null) return found;
  const json = JSON.stringify(input);
  return json === "{}" ? "" : json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

/** Concatenate a tool_result content block (string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b && typeof (b as { text: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => typeof v === "object" && v !== null;

/** Narrow unknown content arrays/objects out of the vendor stream events. */
function asStreamEvent(raw: unknown): AnyRecord | null {
  return isRecord(raw) ? raw : null;
}

export function mapSdkMessage(raw: SDKMessage | unknown, state: TurnState): TurnEvent[] {
  const msg = asStreamEvent(raw);
  if (!msg) return [];
  const type = msg["type"];

  if (type === "stream_event") {
    const evt = asStreamEvent(msg["event"]);
    if (!evt) return [];
    return handleStreamEvent(evt, state);
  }

  if (type === "assistant") {
    const message = asStreamEvent(msg["message"]);
    if (!message) return [];
    const content = Array.isArray(message["content"]) ? message["content"] : [];
    const parent = typeof msg["parent_tool_use_id"] === "string" ? (msg["parent_tool_use_id"] as string) : null;
    if (typeof message["model"] === "string") state.model = message["model"] as string;
    const out: TurnEvent[] = [];
    for (const b of content) {
      const block = asStreamEvent(b);
      if (!block) continue;
      const btype = block["type"];
      if (btype === "tool_use") {
        const id = typeof block["id"] === "string" ? (block["id"] as string) : "";
        const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
        const input = isRecord(block["input"]) ? (block["input"] as Record<string, unknown>) : {};
        if (id && state.seenToolIds.has(id)) continue; // partial mode already delivered
        if (id) state.seenToolIds.add(id);
        out.push({ type: "tool_start", id, name, summary: toolSummary(name, input), input, parentToolUseId: parent });
      }
      // text/thinking blocks in partial mode were already streamed as deltas;
      // non-partial sessions get them here as complete chunks.
      else if (btype === "text" && !state.partial) {
        const text = typeof block["text"] === "string" ? (block["text"] as string) : "";
        if (text) out.push({ type: "text_delta", text });
      } else if (btype === "thinking" && !state.partial) {
        const text = typeof block["thinking"] === "string" ? (block["thinking"] as string) : "";
        if (text) {
          out.push({ type: "thinking_delta", text });
        }
      }
    }
    return out;
  }

  if (type === "user") {
    // Tool results arrive as user messages in stream-json.
    const t = msg as unknown as { message?: { content?: unknown } };
    const content = t.message && Array.isArray(t.message.content) ? t.message.content : [];
    const out: TurnEvent[] = [];
    for (const b of content) {
      const block = asStreamRecord(b);
      if (!block || block["type"] !== "tool_result") continue;
      const id = typeof block["tool_use_id"] === "string" ? (block["tool_use_id"] as string) : "";
      const isError = block["is_error"] === true;
      out.push({
        type: "tool_end",
        id,
        ok: !isError,
        output: resultText(block["content"]).slice(0, MAX_TOOL_OUTPUT_CHARS),
      });
    }
    return out;
  }

  if (type === "result") {
    if (state.emittedTurnEnd) return [];
    state.emittedTurnEnd = true;
    const usage = asStreamRecord(msg["usage"]) ?? {};
    const tokens = {
      input: typeof usage["input_tokens"] === "number" ? (usage["input_tokens"] as number) : null,
      output: typeof usage["output_tokens"] === "number" ? (usage["output_tokens"] as number) : null,
    };
    const isError =
      msg["is_error"] === true ||
      (typeof msg["subtype"] === "string" && msg["subtype"] !== "success");
    const errors = Array.isArray(msg["errors"])
      ? (msg["errors"] as unknown[]).filter((e): e is string => typeof e === "string")
      : [];
    const errorText = isError
      ? errors[0] ?? (typeof msg["result"] === "string" ? (msg["result"] as string) : "turn failed")
      : null;
    return [
      {
        type: "turn_end",
        reason: isError ? "error" : "done",
        model: state.model,
        durationMs: typeof msg["duration_ms"] === "number" ? (msg["duration_ms"] as number) : 0,
        costUsd: typeof msg["total_cost_usd"] === "number" ? (msg["total_cost_usd"] as number) : null,
        tokens,
        error: errorText,
      },
    ];
  }

  // system / informational / unknown frames: ignored, never thrown — a new
  // frame kind from a newer CLI must not break the mapping.
  return [];
}

function handleStreamEvent(evt: AnyRecord, state: TurnState): TurnEvent[] {
  const etype = evt["type"];

  if (etype === "content_block_start") {
    const block = asStreamRecord(evt["content_block"]);
    if (block && block["type"] === "tool_use") {
      const index = typeof evt["index"] === "number" ? (evt["index"] as number) : -1;
      state.openTools.set(index, {
        id: typeof block["id"] === "string" ? (block["id"] as string) : "",
        name: typeof block["name"] === "string" ? (block["name"] as string) : "tool",
        jsonBuf: [],
      });
    }
    return [];
  }

  if (etype === "content_block_delta") {
    const delta = asStreamRecord(evt["delta"]);
    if (!delta) return [];
    const dtype = delta["type"];
    if (dtype === "text_delta") {
      const text = typeof delta["text"] === "string" ? (delta["text"] as string) : "";
      return text ? [{ type: "text_delta", text }] : [];
    }
    if (dtype === "thinking_delta") {
      const text = typeof delta["thinking"] === "string" ? (delta["thinking"] as string) : "";
      return text ? [{ type: "thinking_delta", text }] : [];
    }
    if (dtype === "input_json_delta") {
      const index = typeof evt["index"] === "number" ? (evt["index"] as number) : -1;
      const pending = state.openTools.get(index);
      if (pending && typeof delta["partial_json"] === "string") {
        pending.jsonBuf.push(delta["partial_json"] as string);
      }
      return [];
    }
    return [];
  }

  if (etype === "content_block_stop") {
    const index = typeof evt["index"] === "number" ? (evt["index"] as number) : -1;
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
        // partial buffer corrupted — keep {} (legacy parity)
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

/** Alias for readability at call sites. */
const asStreamRecord = asStreamEvent;
