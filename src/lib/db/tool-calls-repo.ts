import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/**
 * tool_calls audit trail.
 *
 * A row is written when the permission gate DECIDES, not when the tool
 * finishes — a denial must be as visible in the audit as an approval. The
 * result is attached later by tool_use_id when the CLI reports it.
 *
 * Status is a state machine with one allowed regression: denied is terminal
 * (a CLI may still report a denied call as an error result; the audit keeps
 * the decision). Allowed/ok/error are not terminal because a result can
 * arrive for an allowed call.
 */

export type ToolCallStatus = "pending" | "allowed" | "denied" | "ok" | "error";

export interface ToolCallRow {
  id: string;
  conversationId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  status: ToolCallStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

interface RawRow {
  id: string;
  conversation_id: string;
  tool_use_id: string;
  name: string;
  input_json: string | null;
  result_json: string | null;
  status: ToolCallStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const SELECT = `SELECT id, conversation_id, tool_use_id, name, input_json,
  result_json, status, decided_by, decided_at, created_at FROM tool_calls`;

function parseNullable(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null; // audit rendering must never throw on a corrupt row
  }
}

function toRow(raw: RawRow): ToolCallRow {
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    toolUseId: raw.tool_use_id,
    name: raw.name,
    input: parseNullable(raw.input_json),
    result: parseNullable(raw.result_json),
    status: raw.status,
    decidedBy: raw.decided_by,
    decidedAt: raw.decided_at,
    createdAt: raw.created_at,
  };
}

export interface ToolRequestInput {
  conversationId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Write the pending row when the gate ASKS — before the user decides. The
 * decision then lands on this row. Writing it up front is what keeps the
 * audit complete when nobody ever answers (a lost tab, a crashed server): the
 * call is still on record as pending rather than invisible.
 */
export function recordToolRequest(db: DatabaseSync, input: ToolRequestInput): void {
  db.prepare(
    "INSERT INTO tool_calls (id, conversation_id, tool_use_id, name, input_json, status) " +
      "VALUES (?, ?, ?, ?, ?, 'pending') " +
      "ON CONFLICT(conversation_id, tool_use_id) DO NOTHING",
  ).run(
    randomUUID(),
    input.conversationId,
    input.toolUseId,
    input.name,
    JSON.stringify(input.input),
  );
}

export interface ToolDecisionInput {
  conversationId: string;
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  decision: "allow" | "deny";
  decidedBy: string;
}

/**
 * Record the decision for one tool call. Idempotent per tool_use_id: a repeat
 * decision (double-click) updates the existing row instead of duplicating.
 */
export function recordToolDecision(db: DatabaseSync, input: ToolDecisionInput): void {
  const status: ToolCallStatus = input.decision === "allow" ? "allowed" : "denied";
  const existing = db
    .prepare(
      "SELECT id FROM tool_calls WHERE conversation_id = ? AND tool_use_id = ?",
    )
    .get(input.conversationId, input.toolUseId);

  if (existing) {
    db.prepare(
      "UPDATE tool_calls SET status = ?, decided_by = ?, " +
        "decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
        "WHERE conversation_id = ? AND tool_use_id = ?",
    ).run(status, input.decidedBy, input.conversationId, input.toolUseId);
    return;
  }

  db.prepare(
    "INSERT INTO tool_calls (id, conversation_id, tool_use_id, name, input_json, " +
      "status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, " +
      "strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(
    randomUUID(),
    input.conversationId,
    input.toolUseId,
    input.name,
    JSON.stringify(input.input),
    status,
    input.decidedBy,
  );
}

export interface ToolResultInput {
  conversationId: string;
  toolUseId: string;
  ok: boolean;
  output: string;
}

/**
 * Attach a result. Never overwrites a denial's status (the decision is the
 * audit's primary fact) but does store the result for the record. Quietly
 * ignores unknown tool_use_ids: results for calls the gate never saw must not
 * conjure rows.
 */
export function recordToolResult(db: DatabaseSync, input: ToolResultInput): void {
  const existing = db
    .prepare(
      "SELECT status FROM tool_calls WHERE conversation_id = ? AND tool_use_id = ?",
    )
    .get(input.conversationId, input.toolUseId) as
    | { status: ToolCallStatus }
    | undefined;
  if (!existing) return;

  const next: ToolCallStatus =
    existing.status === "denied" ? "denied" : input.ok ? "ok" : "error";
  db.prepare(
    "UPDATE tool_calls SET status = ?, result_json = ? " +
      "WHERE conversation_id = ? AND tool_use_id = ?",
  ).run(
    next,
    JSON.stringify({ ok: input.ok, output: input.output }),
    input.conversationId,
    input.toolUseId,
  );
}

export function listToolCalls(
  db: DatabaseSync,
  conversationId: string,
  limit = 200,
): ToolCallRow[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows.map((r) => toRow(r as unknown as RawRow));
}
