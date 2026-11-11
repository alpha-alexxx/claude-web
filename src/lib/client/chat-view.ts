import type { TurnEvent } from "@/lib/providers/types";

/**
 * TurnView: pure TurnEvent → view-model accumulator. One reducer for every
 * provider (they all speak TurnEvent); components render this shape and
 * contain no stream logic.
 *
 * Design:
 * - A conversation is turns: user messages and assistant turns.
 * - One assistant turn is an ordered list of BLOCKS (text, thinking, tool,
 *   permission) appended in event arrival order — chat is interleaved
 *   ("let me check…", tool card, "the answer is…"), so a single text field
 *   would lose that order.
 * - Immutable: reducers return fresh objects, inputs never mutated — safe
 *   for strict-mode React state and snapshot assertions alike.
 *
 * Streaming state machine:
 *   running=true, started=false → "starting…" (turn accepted, no event yet —
 *                               the CLI is silent ~60s on this host)
 *   running=true, started=true  → streaming
 *   running=false               → turn ended (end carries usage for the footer)
 */

export interface ToolCallView {
  id: string;
  name: string;
  summary: string;
  input: Record<string, unknown>;
  output: string | null;
  ok: boolean | null;
  status: "running" | "ok" | "error";
  /** Non-null when a subagent (parent tool_use) produced the call. */
  parentToolUseId: string | null;
}

/** Mirrors the answer route's zod enum — one vocabulary on both sides. */
export type PermissionDecision = "allow" | "deny" | "allow_session";

export interface PermissionCardView {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  displayHint: string | null;
  status: "pending" | "answered";
  answer: PermissionDecision | null;
}

export interface TurnEndView {
  reason: "done" | "error" | "interrupted";
  model: string | null;
  durationMs: number;
  costUsd: number | null;
  tokens: { input: number | null; output: number | null };
  error: string | null;
}

export type AssistantBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolCallView }
  | { kind: "permission"; card: PermissionCardView };

export interface AssistantTurn {
  kind: "assistant";
  blocks: AssistantBlock[];
  end: TurnEndView | null;
}

export interface UserTurn {
  kind: "user";
  text: string;
}

export interface TurnView {
  turns: (UserTurn | AssistantTurn)[];
  /** True between pushUserMessage and turn_end. */
  running: boolean;
  /** Flips on the first event of the current turn (starting → streaming). */
  started: boolean;
}

export function initialView(): TurnView {
  return { turns: [], running: false, started: false };
}

/**
 * Client-side synthesis for a POST that produced no stream at all (4xx/5xx,
 * network failure): reduces exactly like a server-sent error turn_end.
 */
export function turnErrorEvent(message: string): TurnEvent {
  return {
    type: "turn_end",
    reason: "error",
    model: null,
    durationMs: 0,
    costUsd: null,
    tokens: { input: null, output: null },
    error: message,
  };
}

export function pushUserMessage(view: TurnView, text: string): TurnView {
  // A stream that died without turn_end leaves the previous assistant turn
  // open; closing it as an error keeps the transcript truthful.
  const closed = closeOpenTurn(view, "connection lost before the turn ended");
  return {
    ...closed,
    running: true,
    started: false,
    turns: [...closed.turns, { kind: "user", text }],
  };
}

export function reduceTurnEvent(view: TurnView, event: TurnEvent): TurnView {
  if (event.type === "turn_end") return applyTurnEnd(view, event);

  const turns = view.turns;
  const last = turns[turns.length - 1];
  const hasOpen = !!last && last.kind === "assistant" && last.end === null;

  // A tool_end with no open turn is pure noise (the server pairs starts with
  // ends inside one stream) — it must not conjure an empty assistant turn.
  if (event.type === "tool_end" && !hasOpen) return view;

  const turn = hasOpen
    ? (last as AssistantTurn)
    : ({ kind: "assistant", blocks: [], end: null } as AssistantTurn);

  const newTurns = turns.slice();
  newTurns[hasOpen ? turns.length - 1 : turns.length] = applyBlock(turn, event);
  return { turns: newTurns, running: true, started: true };
}

/**
 * Mark one pending card answered. Purely local: the transport POSTs the
 * answer separately, and this is what stops the card from looking answerable
 * while the request is in flight. Returns the view unchanged when the id is
 * unknown or the card was already answered — a double click, or a frame that
 * raced the click, must not resurrect a card.
 *
 * The turn keeps running: an answered card does not end anything.
 */
export function answerPermissionCard(
  view: TurnView,
  requestId: string,
  decision: PermissionDecision,
): TurnView {
  let found = false;
  const turns = view.turns.map((turn) => {
    if (turn.kind !== "assistant") return turn;
    let turnChanged = false;
    const blocks = turn.blocks.map((block): AssistantBlock => {
      if (block.kind !== "permission") return block;
      const { card } = block;
      if (card.requestId !== requestId || card.status === "answered") return block;
      turnChanged = true;
      found = true;
      return { kind: "permission", card: { ...card, status: "answered", answer: decision } };
    });
    return turnChanged ? { ...turn, blocks } : turn;
  });
  return found ? { ...view, turns } : view;
}

// -- internals ---------------------------------------------------------------

type EndEvent = Extract<TurnEvent, { type: "turn_end" }>;

function applyTurnEnd(view: TurnView, event: EndEvent): TurnView {
  const end: TurnEndView = {
    reason: event.reason,
    model: event.model,
    durationMs: event.durationMs,
    costUsd: event.costUsd,
    tokens: event.tokens,
    error: event.error,
  };
  const turns = view.turns;
  const last = turns[turns.length - 1];
  const hasOpen = !!last && last.kind === "assistant" && last.end === null;

  const newTurns = turns.slice();
  if (hasOpen) {
    newTurns[newTurns.length - 1] = { ...(last as AssistantTurn), end };
  } else {
    // e.g. a POST that failed before any frame: the turn still gets a
    // closeable assistant entry so the error is visible in the transcript.
    newTurns.push({ kind: "assistant", blocks: [], end });
  }
  return { turns: newTurns, running: false, started: view.started };
}

function applyBlock(turn: AssistantTurn, event: TurnEvent): AssistantTurn {
  const blocks = turn.blocks;

  switch (event.type) {
    case "text_delta":
      return appendDeltaBlock(turn, blocks, "text", event.text);
    case "thinking_delta":
      return appendDeltaBlock(turn, blocks, "thinking", event.text);

    case "tool_start":
      return {
        ...turn,
        blocks: [
          ...blocks,
          {
            kind: "tool",
            tool: {
              id: event.id,
              name: event.name,
              summary: event.summary,
              input: event.input,
              output: null,
              ok: null,
              status: "running",
              parentToolUseId: event.parentToolUseId,
            },
          },
        ],
      };

    case "tool_end": {
      const idx = blocks.findIndex(
        (b) => b.kind === "tool" && b.tool.id === event.id,
      );
      if (idx === -1) return turn; // ghost end — ignore, never throw
      const updated = blocks.slice();
      const block = updated[idx];
      if (block.kind !== "tool") return turn;
      updated[idx] = {
        kind: "tool",
        tool: {
          ...block.tool,
          output: event.output,
          ok: event.ok,
          status: event.ok ? "ok" : "error",
        },
      };
      return { ...turn, blocks: updated };
    }

    case "permission_request":
      return {
        ...turn,
        blocks: [
          ...blocks,
          {
            kind: "permission",
            card: {
              requestId: event.requestId,
              toolName: event.toolName,
              toolUseId: event.toolUseId,
              input: event.input,
              displayHint: event.displayHint,
              status: "pending",
              answer: null,
            },
          },
        ],
      };

    default:
      return turn;
  }
}

/** Merge a delta into the last block when it is the same kind, else append. */
function appendDeltaBlock(
  turn: AssistantTurn,
  blocks: AssistantBlock[],
  kind: "text" | "thinking",
  text: string,
): AssistantTurn {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) {
    const updated = blocks.slice();
    updated[updated.length - 1] = { kind, text: last.text + text };
    return { ...turn, blocks: updated };
  }
  return { ...turn, blocks: [...blocks, { kind, text }] };
}

/** Close a still-open assistant turn as an error (stale-stream case). */
function closeOpenTurn(view: TurnView, message: string): TurnView {
  const turns = view.turns;
  const last = turns[turns.length - 1];
  if (!last || last.kind !== "assistant" || last.end !== null) return view;
  const newTurns = turns.slice();
  newTurns[newTurns.length - 1] = {
    ...(last as AssistantTurn),
    end: {
      reason: "error",
      model: null,
      durationMs: 0,
      costUsd: null,
      tokens: { input: null, output: null },
      error: message,
    },
  };
  return { ...view, turns: newTurns };
}
