"use client";

/**
 * Cross-component signal that the conversation list is stale.
 *
 * The sidebar cannot observe the chat column's server writes: a turn creates
 * its `conversations` row and updates `updated_at` inside the chat route, with
 * no response the sidebar sees. Rather than poll, the column announces "a turn
 * just ended" and the list refetches once.
 *
 * A DOM event rather than React context because the two live in different
 * subtrees (layout vs page) and the sidebar is rendered inside a portal on
 * mobile — context would have to be threaded through the shell for one signal.
 */

export const CONVERSATIONS_CHANGED = "claude-web:conversations-changed";

export function emitConversationsChanged(): void {
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
}
