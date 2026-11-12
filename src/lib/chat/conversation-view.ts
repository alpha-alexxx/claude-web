import type { ConversationRow } from "@/lib/db/conversations-repo";

/**
 * Client-facing shape of a conversation row.
 *
 * Rows are keyed `${userId}:${clientId}` — a server-derived id so a browser
 * cannot address another user's row. The prefix is OUR identity, not the
 * client's: it is stripped on the way out so URLs (`/chat/<clientId>`) stay
 * stable, share nothing about the account, and can be re-prefixed with the
 * caller's own id on the way back in.
 *
 * Shared by the list route and the single-conversation route so both answer
 * with the same object — a sidebar entry and a replayed conversation must
 * describe themselves identically.
 *
 * `cliSessionId` is deliberately ABSENT: it is the resume target, the one
 * handle that lets a process attach to an existing CLI session. It stays in
 * the `conversations` column and in the adapter, and the browser never needs
 * to name it — so it is never handed to the browser, not even as a field the
 * UI happens to ignore. A client that needs to continue a conversation sends
 * its own client id and lets the server resolve the session.
 */

/** Strip the `${userId}:` prefix; a row without one is returned as-is. */
export function clientIdOf(row: ConversationRow): string {
  const prefix = `${row.userId}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  cwd: string | null;
  updatedAt: string;
}

export function conversationSummary(row: ConversationRow): ConversationSummary {
  return {
    id: clientIdOf(row),
    title: row.title,
    provider: row.provider,
    model: row.model,
    cwd: row.cwd,
    updatedAt: row.updatedAt,
  };
}
