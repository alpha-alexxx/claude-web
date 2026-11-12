import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { bodyTooLarge, sameOrigin } from "@/lib/auth/request-guards";
import { getAdapter } from "@/lib/providers/registry";
import { getBootDb } from "@/lib/db/boot";
import {
  conversationIdFor,
  deleteConversation,
  findConversation,
  renameConversation,
  type ConversationRow,
} from "@/lib/db/conversations-repo";
import { listMessages } from "@/lib/db/messages-repo";
import { viewFromMessages } from "@/lib/chat/transcript";
import { conversationSummary } from "@/lib/chat/conversation-view";

/**
 * /api/conversations/[id] — one conversation: replay, rename, delete.
 *
 * `[id]` is the CLIENT id (what the URL carries). The row key is
 * `conversationIdFor(userId, id)`, so ownership is decided by construction:
 * `user_2` asking for `user_1`'s client id derives `user_2:...`, finds
 * nothing, and gets the same 404 a nonexistent id gets. That equivalence is
 * deliberate — distinct responses would make ids probeable.
 *
 * History is returned as a finished VIEW (`viewFromMessages`): permission
 * cards in a replayed turn are answered-by-history, never live buttons.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. Auth + the cookie-scoped DB read keep every response
 * request-time, and every response is `no-store` because it is per-user data.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

const TITLE_MAX = 200;

const PatchSchema = z.object({ title: z.string().max(TITLE_MAX * 4) });

function notFound(): Response {
  // One body for "missing" and "someone else's" — see the note above.
  return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
}

/** The caller's row for this client id, or null. */
function ownedRow(
  userId: string,
  clientId: string,
): ConversationRow | null {
  const row = findConversation(getBootDb(), conversationIdFor(userId, clientId));
  // The PK already carries the user, but re-check: a row written by a future
  // migration that drops the prefix must still never cross accounts.
  return row && row.userId === userId ? row : null;
}

async function gate(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<
  | { ok: false; response: Response }
  | { ok: true; userId: string; clientId: string; row: ConversationRow }
> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return {
      ok: false,
      response: Response.json(
        { error: decision.code },
        { status: decision.status, headers: NO_STORE },
      ),
    };
  }
  if (!sameOrigin(req)) {
    return {
      ok: false,
      response: Response.json(
        { error: "cross_origin" },
        { status: 403, headers: NO_STORE },
      ),
    };
  }
  const { id } = await ctx.params;
  const userId = String(decision.user.id);
  const row = ownedRow(userId, id);
  if (!row) return { ok: false, response: notFound() };
  return { ok: true, userId, clientId: id, row };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await gate(req, ctx);
  if (!g.ok) return g.response;

  const rows = listMessages(getBootDb(), g.row.id);
  return Response.json(
    {
      conversation: conversationSummary(g.row),
      view: viewFromMessages(rows),
    },
    { headers: NO_STORE },
  );
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await gate(req, ctx);
  if (!g.ok) return g.response;

  let raw: unknown;
  if (bodyTooLarge(req)) {
    return Response.json({ error: "body_too_large" }, { status: 413, headers: NO_STORE });
  }
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }
  // Trim before validating length: "   " is an empty title, not a 3-char one.
  const title = parsed.data.title.trim();
  if (title.length === 0 || title.length > TITLE_MAX) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  // The update is owner-scoped, so `false` means the row vanished between the
  // gate read and this write (another tab deleted it). Report that instead of
  // answering "renamed" for a no-op.
  if (!renameConversation(getBootDb(), g.row.id, g.userId, title)) {
    return notFound();
  }
  return Response.json({ ok: true, title }, { headers: NO_STORE });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = await gate(req, ctx);
  if (!g.ok) return g.response;

  // End the turn BEFORE the row disappears. A live agent whose conversation is
  // deleted keeps running — spending money, holding the pool slot — while its
  // transcript writes fail the FK and are swallowed; a later turn could even
  // resurrect a partial row under the same key. The adapter comes from the
  // row's own provider (never a client value), and the interrupt is
  // best-effort: a CLI that died mid-call must not turn delete into a 500.
  const session = getAdapter(g.row.provider)?.liveSession?.(g.row.id) ?? null;
  if (session) {
    try {
      await session.interrupt();
    } catch {
      // swallowed by design — the row still has to go
    }
  }

  // Messages and tool_calls cascade (FKs are ON in getDb).
  deleteConversation(getBootDb(), g.row.id, g.userId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
