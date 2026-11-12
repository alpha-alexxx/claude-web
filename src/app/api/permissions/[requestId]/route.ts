import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { BODY_CAPS, bodyTooLarge, sameOrigin } from "@/lib/auth/request-guards";
import { getPermissionBroker } from "@/lib/providers/claude/broker";

/**
 * POST /api/permissions/[requestId] — answer an interactive Allow/Deny card.
 *
 * The broker is the authority on ownership: it only resolves a request whose
 * userId matches the caller, and only once. This route's own job is to make
 * that reachable safely — auth, Origin, rate limit, body validation.
 *
 * Fail closed in every direction: an unknown id is a 404 the UI treats as
 * "already answered" (the card is disabled), and the waiting CLI call is
 * denied by the broker's timeout if nothing ever answers.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. A POST handler is never prerendered.
 */

const BodySchema = z.object({
  decision: z.enum(["allow", "deny", "allow_session"]),
});


function json(status: number, body: Record<string, unknown>, headers?: Record<string, string>) {
  return Response.json(body, { status, headers });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) return json(decision.status, { error: decision.code });

  if (!sameOrigin(req)) return json(403, { error: "cross_origin" });

  // Shares the turn bucket, like the model switch: an answer is cheap, but
  // this endpoint is a privileged control on a live agent process.
  const limit = checkRateLimit(
    { bucket: "turn", id: String(decision.user.id) },
    RATE_LIMITS.turn,
  );
  if (!limit.allowed) {
    return json(
      429,
      { error: "rate_limited" },
      { "retry-after": String(limit.retryAfterSec) },
    );
  }

  if (bodyTooLarge(req, BODY_CAPS.answer)) return json(413, { error: "body_too_large" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json(400, { error: "invalid_body" });

  const { requestId } = await ctx.params;
  const result = getPermissionBroker().resolve(
    decision.user.id,
    requestId,
    parsed.data.decision,
  );
  if (!result.ok) return json(404, { error: result.code });
  return json(200, { ok: true, decision: result.decision });
}
