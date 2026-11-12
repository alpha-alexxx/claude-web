import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getAdapter } from "@/lib/providers/registry";
import { getBootDb } from "@/lib/db/boot";
import { conversationIdFor, findConversation } from "@/lib/db/conversations-repo";

/**
 * POST /api/chat/[id]/model — switch the model of a LIVE session.
 *
 * Mirrors the Stop route: it peeks the pool and never spawns a CLI. A
 * conversation without a live session takes its next model from the turn
 * request instead (spawn options are only meaningful then), so 404 here is
 * a no-op for the UI, not an error to surface.
 *
 * The provider comes from the caller's OWN row, and `provider` in the body is
 * optional: a body default would silently target the wrong adapter whenever a
 * stale tab posts to a conversation that has since been written by another
 * provider. A body value that disagrees with the row is a 409, not a guess.
 *
 * No segment config: under `cacheComponents`, `dynamic = "force-dynamic"` is
 * rejected at build time — the request-time APIs this handler already calls
 * keep it out of the prerender.
 */

const BodySchema = z.object({
  /** "auto" = CLI default (clears any override). */
  model: z.string().min(1).max(128),
  /** Optional cross-check; the row is authoritative when present. */
  provider: z.enum(["claude", "codex", "opencode", "qoder"]).optional(),
});

function json(status: number, error: string) {
  return Response.json({ error }, { status });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) return json(decision.status, decision.code);

  if (!sameOrigin(req)) return json(403, "cross_origin");

  // Shares the turn bucket: a model switch is cheap but it is still a
  // per-user write into a live agent process.
  const limit = checkRateLimit(
    { bucket: "turn", id: String(decision.user.id) },
    RATE_LIMITS.turn,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }

  if (bodyTooLarge(req)) return json(413, "body_too_large");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, "invalid_json");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json(400, "invalid_body");

  const { id } = await ctx.params;
  const row = findConversation(
    getBootDb(),
    conversationIdFor(String(decision.user.id), id),
  );
  if (!row || row.userId !== String(decision.user.id)) {
    return json(404, "no_live_session");
  }
  if (parsed.data.provider && parsed.data.provider !== row.provider) {
    return json(409, "provider_mismatch");
  }

  const adapter = getAdapter(row.provider);
  const session = adapter?.liveSession?.(row.id) ?? null;
  if (!session) return json(404, "no_live_session");

  try {
    await session.setModel?.(
      parsed.data.model === "auto" ? undefined : parsed.data.model,
    );
  } catch {
    // A model switch during a running turn is best-effort by design; the
    // next turn still carries the model from POST /api/chat.
  }
  return Response.json({ ok: true });
}
