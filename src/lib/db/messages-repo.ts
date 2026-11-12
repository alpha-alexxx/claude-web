import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Transcript rows — the durable half of a conversation.
 *
 * The session pool is ephemeral: it caps at MAX_CONCURRENT_TURNS, evicts by
 * LRU, and dies with the process. These rows are what a reopened conversation
 * is rebuilt from, and the row they are attached to (`conversations`) is what
 * carries the CLI session id that makes resume possible.
 *
 * `content_json` is the VIEW-MODEL shape, not a provider's wire format. The
 * browser already reduces events into that shape (chat-view.ts), so persisting
 * it verbatim means replay is a deserialize and the UI never needs to know
 * which provider produced a turn. Nothing provider-specific is stored.
 */

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRow {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: Record<string, unknown>;
  createdAt: string;
}

interface RawRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content_json: string;
  created_at: string;
}

const SELECT = `SELECT id, conversation_id, role, content_json, created_at FROM messages`;

function toRow(raw: RawRow): MessageRow | null {
  let content: unknown;
  try {
    content = JSON.parse(raw.content_json);
  } catch {
    // A torn write or a manual edit leaves invalid JSON in a column no
    // constraint can police. Dropping the row keeps the rest of the
    // transcript readable; throwing here would turn GET into a 500 and make
    // the conversation permanently unopenable, which is a worse failure than
    // one missing message. transcript.ts promises replay never throws — that
    // promise has to hold at the layer that actually parses.
    console.error(`[transcript] dropping message ${raw.id}: content_json is not JSON`);
    return null;
  }
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    console.error(`[transcript] dropping message ${raw.id}: content_json is not an object`);
    return null;
  }
  return {
    id: raw.id,
    conversationId: raw.conversation_id,
    role: raw.role,
    content: content as Record<string, unknown>,
    createdAt: raw.created_at,
  };
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: Record<string, unknown>;
}

/**
 * Append one message and touch the conversation, so the sidebar's ordering is
 * "last activity", not "last time a row was created".
 *
 * The caller owns ownership checks: a conversation id is already
 * user-scoped (`conversationIdFor`), so a row reachable here belongs to the
 * user whose id prefixes it.
 */
export function appendMessage(db: DatabaseSync, input: AppendMessageInput): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content_json) VALUES (?, ?, ?, ?)",
  ).run(id, input.conversationId, input.role, JSON.stringify(input.content));
  db.prepare(
    "UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(input.conversationId);
  return id;
}

/**
 * Oldest-first transcript window, `limit` rows counting back from the end.
 *
 * The window keeps the NEWEST rows, not the oldest: a long conversation that
 * exceeds the cap is one whose tail the user is currently reading, and an
 * ascending LIMIT would silently replay it without its conclusion. The query
 * therefore orders descending to take the tail, then reverses in memory so
 * callers still get transcript order.
 *
 * `rowid` is the tiebreak in both directions because two messages can share a
 * millisecond and reordered history is worse than missing history.
 */
export function listMessages(
  db: DatabaseSync,
  conversationId: string,
  limit = 500,
): MessageRow[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(conversationId, limit);
  return rows
    .map((r) => toRow(r as unknown as RawRow))
    .filter((r): r is MessageRow => r !== null)
    .reverse();
}
