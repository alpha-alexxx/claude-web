import { requireActor } from "@/lib/auth/current-actor";
import { getBootDb } from "@/lib/db/boot";
import { listConversations } from "@/lib/db/conversations-repo";
import { conversationSummary } from "@/lib/chat/conversation-view";

/**
 * GET /api/conversations — the sidebar's list.
 *
 * Owner-scoped in SQL (`WHERE user_id = ?`), never filtered afterwards: a
 * list assembled in JS and then filtered is one refactor away from leaking
 * another user's titles.
 *
 * Ids returned here are the CLIENT ids (see conversation-view.ts), not the
 * row keys — the `${userId}:` prefix is server-side addressing, not part of
 * what the browser holds.
 *
 * `no-store`: this is per-user data behind a cookie. Any cache that is not
 * keyed on the session (a proxy, a browser BFCache) would serve one user's
 * list to another.
 */
export async function GET(): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }

  const rows = listConversations(getBootDb(), String(decision.user.id));
  return Response.json(
    { conversations: rows.map(conversationSummary) },
    { headers: { "cache-control": "no-store" } },
  );
}
