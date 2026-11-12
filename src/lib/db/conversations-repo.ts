import type { DatabaseSync } from "node:sqlite";

/**
 * Conversation rows — created by the SERVER, never by the client.
 *
 * The id is derived (`${userId}:${clientConversationId}`) and is the same
 * string the session pool uses as its key. Deriving it here means a client
 * cannot address another user's conversation even if it sends their id:
 * `user_2` posting `conversationId: "c1"` becomes `user_2:c1`, never
 * `user_1:c1`. That derivation is what makes the `tool_calls` foreign key
 * trustworthy before Phase 5 formalizes ownership.
 *
 * The row also has to exist before the first audit write — `tool_calls`
 * references `conversations(id)` — so the chat route calls this before it
 * starts the session.
 */

export interface ConversationRow {
  id: string;
  userId: string;
  provider: string;
  title: string | null;
  cliSessionId: string | null;
  model: string | null;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  user_id: string;
  provider: string;
  title: string | null;
  cli_session_id: string | null;
  model: string | null;
  cwd: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, user_id, provider, title, cli_session_id, model, cwd,
  created_at, updated_at FROM conversations`;

function toRow(raw: RawRow): ConversationRow {
  return {
    id: raw.id,
    userId: raw.user_id,
    provider: raw.provider,
    title: raw.title,
    cliSessionId: raw.cli_session_id,
    model: raw.model,
    cwd: raw.cwd,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Server-derived, user-scoped id — the pool key and the conversations PK. */
export function conversationIdFor(userId: string, clientConversationId: string): string {
  return `${userId}:${clientConversationId}`;
}

export interface EnsureConversationInput {
  /** `conversationIdFor(userId, clientId)` — callers never pass a raw id. */
  id: string;
  userId: string;
  provider: string;
  cwd: string;
  model: string | null;
  title?: string | null;
  cliSessionId?: string | null;
}

/**
 * Create the row on first turn, refresh it on later turns. Idempotent.
 *
 * The UPDATE is owner-guarded: a row that somehow belongs to another user is
 * left untouched. An audit trail that can be repointed at someone else's
 * conversation is worse than a missing one.
 *
 * `model` keeps its stored value when the turn carries none — "no override"
 * means the conversation's last explicit choice stands, not that it is
 * forgotten.
 */
export function ensureConversation(
  db: DatabaseSync,
  input: EnsureConversationInput,
): void {
  const existing = findConversation(db, input.id);
  if (!existing) {
    db.prepare(
      "INSERT INTO conversations (id, user_id, provider, title, cli_session_id, model, cwd) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.id,
      input.userId,
      input.provider,
      input.title ?? null,
      input.cliSessionId ?? null,
      input.model,
      input.cwd,
    );
    return;
  }
  if (existing.userId !== input.userId) return;

  db.prepare(
    "UPDATE conversations SET provider = ?, cwd = ?, " +
      "model = COALESCE(?, model), " +
      "cli_session_id = COALESCE(?, cli_session_id), " +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(
    input.provider,
    input.cwd,
    input.model,
    input.cliSessionId ?? null,
    input.id,
  );
}

export function findConversation(
  db: DatabaseSync,
  id: string,
): ConversationRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row ? toRow(row as unknown as RawRow) : null;
}

/**
 * Sidebar listing: one user's conversations, most recent activity first.
 *
 * Rows with no messages are hidden even though the chat route creates them on
 * mount — /chat/[id] needs a real row before the first turn so the URL, the
 * audit FK and the resume target all exist. An empty row is a conversation
 * the user never used, and listing it would fill the sidebar with noise. The
 * EXISTS subquery keeps this a single statement (no N+1 over message counts).
 */
export function listConversations(
  db: DatabaseSync,
  userId: string,
  limit = 100,
): ConversationRow[] {
  const rows = db
    .prepare(
      `${SELECT} WHERE user_id = ? AND EXISTS (SELECT 1 FROM messages m ` +
        `WHERE m.conversation_id = conversations.id) ` +
        `ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, limit);
  return rows.map((r) => toRow(r as unknown as RawRow));
}

/**
 * Delete one conversation. Owner-guarded: the WHERE clause carries `user_id`,
 * so a wrong id deletes nothing and reports false rather than acting on
 * someone else's row. Messages and tool_calls cascade (FKs are ON).
 */
export function deleteConversation(
  db: DatabaseSync,
  id: string,
  userId: string,
): boolean {
  const result = db
    .prepare("DELETE FROM conversations WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return Number(result.changes) > 0;
}

/** Rename, owner-guarded. Empty/whitespace titles are rejected by the route. */
export function renameConversation(
  db: DatabaseSync,
  id: string,
  userId: string,
  title: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE conversations SET title = ?, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?",
    )
    .run(title, id, userId);
  return Number(result.changes) > 0;
}

/**
 * Set the title if it is still empty. The first user message is the title, but
 * a later turn must never overwrite a title the user chose (or an earlier
 * derivation) — hence the `title IS NULL` predicate rather than a blind write.
 */
export function ensureTitle(db: DatabaseSync, id: string, title: string): void {
  db.prepare(
    "UPDATE conversations SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
  ).run(title, id);
}

/**
 * Persist the CLI's own session id so a reopened conversation can `resume`.
 *
 * Written at session creation and again whenever a frame reveals it (the init
 * frame is the first place it appears). An empty string is a no-op: a missing
 * value must never clobber a good one.
 */
export function setCliSessionId(
  db: DatabaseSync,
  id: string,
  cliSessionId: string,
): void {
  if (!cliSessionId) return;
  db.prepare("UPDATE conversations SET cli_session_id = ? WHERE id = ?").run(
    cliSessionId,
    id,
  );
}
