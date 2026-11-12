import type { DatabaseSync } from "node:sqlite";
import {
  conversationIdFor,
  findConversation,
} from "@/lib/db/conversations-repo";
import { listMessages } from "@/lib/db/messages-repo";
import { viewFromMessages } from "@/lib/chat/transcript";
import {
  conversationSummary,
  type ConversationSummary,
} from "@/lib/chat/conversation-view";
import type { TurnView } from "@/lib/client/chat-view";

/**
 * Server-side load of one conversation for `/chat/[id]`.
 *
 * Deliberately the same three steps as GET /api/conversations/[id] — derive
 * the row key from the CALLER'S id, read the row, replay the transcript —
 * because the page and the API must answer the same 404 for the same ids. If
 * the page ever loaded more than the API would, the difference would be an
 * authorization gap that only shows up in the browser.
 *
 * Ownership is by construction: `conversationIdFor(userId, clientId)` cannot
 * name another user's row, and the userId equality check is kept as a
 * belt-and-braces guard for a future schema change that drops the prefix.
 */
export interface LoadedConversation {
  summary: ConversationSummary;
  view: TurnView;
}

export function loadConversation(
  db: DatabaseSync,
  userId: string,
  clientId: string,
): LoadedConversation | null {
  const row = findConversation(db, conversationIdFor(userId, clientId));
  if (!row || row.userId !== userId) return null;

  return {
    summary: conversationSummary(row),
    view: viewFromMessages(listMessages(db, row.id)),
  };
}
