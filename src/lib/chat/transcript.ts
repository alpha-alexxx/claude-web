import {
  initialView,
  type AssistantBlock,
  type AssistantTurn,
  type TurnEndView,
  type TurnView,
} from "@/lib/client/chat-view";
import type { MessageRole } from "@/lib/db/messages-repo";

/**
 * Transcript persistence helpers — pure, shared by the server (which writes
 * and replays history) and the tests.
 *
 * The stored shape is the VIEW MODEL (`AssistantTurn { blocks, end }`), not a
 * provider's wire format. The browser already reduces TurnEvents into it, and
 * the server reducer does the same while a turn runs, so replay is a
 * deserialize: a reopened conversation renders identically without the UI
 * knowing which provider produced it.
 *
 * Everything read back from SQLite is untrusted input (an older build, a
 * hand-edited row). The parsers below are total: unknown blocks are dropped,
 * a malformed row is skipped, and a replay never throws.
 */

export interface PersistedMessage {
  role: MessageRole;
  content: Record<string, unknown>;
}

/** Sidebar/first-message title: one line, bounded, never empty. */
export const TITLE_MAX = 80;

export function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New conversation";
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX - 1).trimEnd() + "…" : flat;
}

/**
 * One user message's stored content. Kept as an object (not a bare string) so
 * later fields (attachments, skill invocation) can join without a migration.
 */
export function userMessageContent(text: string): Record<string, unknown> {
  return { text };
}

/** One finished assistant turn's stored content. */
export function assistantMessageContent(turn: AssistantTurn): Record<string, unknown> {
  return { blocks: turn.blocks, end: turn.end };
}

/**
 * Rebuild a read-only view from persisted rows.
 *
 * History is always finished: `running` is false, so the composer is live but
 * no half-turn renders as streaming. Any permission card that survived to a
 * persisted turn is history too — the turn it belonged to is over, so the card
 * must never look answerable (the UI omits onAnswer in replay as well).
 */
export function viewFromMessages(rows: PersistedMessage[]): TurnView {
  const turns: (AssistantTurn | { kind: "user"; text: string })[] = [];

  for (const row of rows) {
    if (row.role === "user") {
      const text = row.content["text"];
      if (typeof text === "string") turns.push({ kind: "user", text });
      continue;
    }
    if (row.role !== "assistant") continue;

    const blocks = parseBlocks(row.content["blocks"]);
    const end = parseEnd(row.content["end"]);
    if (blocks.length === 0 && end === null) continue;
    turns.push({ kind: "assistant", blocks, end });
  }

  const view = initialView();
  return { ...view, turns, running: false, started: false };
}

// -- parsers -----------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBlocks(raw: unknown): AssistantBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantBlock[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    switch (item["kind"]) {
      case "text":
      case "thinking": {
        const text = item["text"];
        if (typeof text === "string") {
          out.push({ kind: item["kind"], text });
        }
        break;
      }
      case "tool": {
        const tool = item["tool"];
        if (
          isRecord(tool) &&
          typeof tool["id"] === "string" &&
          typeof tool["name"] === "string"
        ) {
          out.push({
            kind: "tool",
            tool: {
              id: tool["id"],
              name: tool["name"],
              summary: typeof tool["summary"] === "string" ? tool["summary"] : "",
              input: isRecord(tool["input"]) ? tool["input"] : {},
              output: typeof tool["output"] === "string" ? tool["output"] : null,
              ok: typeof tool["ok"] === "boolean" ? tool["ok"] : null,
              status:
                tool["status"] === "ok" ||
                tool["status"] === "error" ||
                tool["status"] === "running"
                  ? tool["status"]
                  : "error",
              parentToolUseId:
                typeof tool["parentToolUseId"] === "string"
                  ? tool["parentToolUseId"]
                  : null,
            },
          });
        }
        break;
      }
      case "permission": {
        const card = item["card"];
        if (isRecord(card) && typeof card["requestId"] === "string") {
          out.push({
            kind: "permission",
            card: {
              requestId: card["requestId"],
              toolName: typeof card["toolName"] === "string" ? card["toolName"] : "tool",
              toolUseId:
                typeof card["toolUseId"] === "string" ? card["toolUseId"] : "",
              input: isRecord(card["input"]) ? card["input"] : {},
              displayHint:
                typeof card["displayHint"] === "string" ? card["displayHint"] : null,
              // Persisted cards are history: never pending, never answerable.
              status: "answered",
              answer:
                card["answer"] === "allow" ||
                card["answer"] === "deny" ||
                card["answer"] === "allow_session"
                  ? card["answer"]
                  : null,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const REASONS = new Set(["done", "error", "interrupted"]);

function parseEnd(raw: unknown): TurnEndView | null {
  if (!isRecord(raw)) return null;
  const reason = raw["reason"];
  if (typeof reason !== "string" || !REASONS.has(reason)) return null;
  const tokens = isRecord(raw["tokens"]) ? raw["tokens"] : {};
  return {
    reason: reason as TurnEndView["reason"],
    model: typeof raw["model"] === "string" ? raw["model"] : null,
    durationMs: typeof raw["durationMs"] === "number" ? raw["durationMs"] : 0,
    costUsd: typeof raw["costUsd"] === "number" ? raw["costUsd"] : null,
    tokens: {
      input: typeof tokens["input"] === "number" ? tokens["input"] : null,
      output: typeof tokens["output"] === "number" ? tokens["output"] : null,
    },
    error: typeof raw["error"] === "string" ? raw["error"] : null,
  };
}
