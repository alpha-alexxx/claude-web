import { requireActor } from "@/lib/auth/current-actor";
import { sameOrigin } from "@/lib/auth/request-guards";
import { getAdapter } from "@/lib/providers/registry";
import { getBootDb } from "@/lib/db/boot";
import { conversationIdFor, findConversation } from "@/lib/db/conversations-repo";

/**
 * POST /api/chat/[id]/stop — the Stop button.
 *
 * Peeks the live pool session and interrupts it. Deliberately never starts a
 * session: stopping a conversation that has no live CLI process must be a
 * cheap 404, not a fresh `claude` spawn.
 *
 * `[id]` is the client conversation id; it is scoped by user before it
 * reaches the pool, exactly as in POST /api/chat.
 *
 * The provider comes from the caller's OWN conversation row, not from the
 * request or a default: a client-supplied provider would let one user's click
 * reach another adapter's pool, and a default would silently 404 every
 * non-Claude conversation once those adapters land. A missing/foreign row is
 * the same 404 as no live session — distinguishing them would make ids
 * probeable.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time; this handler reads a live in-memory pool, so it can never be
 * prerendered regardless.
 */

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }
  if (!sameOrigin(req)) {
    return Response.json({ error: "cross_origin" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const row = findConversation(
    getBootDb(),
    conversationIdFor(String(decision.user.id), id),
  );
  if (!row || row.userId !== String(decision.user.id)) {
    return Response.json({ error: "no_live_session" }, { status: 404 });
  }

  const session = getAdapter(row.provider)?.liveSession?.(row.id) ?? null;
  if (!session) {
    return Response.json({ error: "no_live_session" }, { status: 404 });
  }

  // An interrupt against a turn that just finished races the CLI's own
  // completion; the turn is over either way, so success is the honest answer.
  try {
    await session.interrupt();
  } catch {
    // swallowed by design — see above
  }
  return Response.json({ ok: true });
}
