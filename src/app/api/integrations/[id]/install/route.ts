import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { getEnv } from "@/lib/env";
import { runInstall, runUninstall } from "@/lib/integrations/installer";
import { invalidateDetection } from "@/lib/integrations/detect";
import { integrationSpec } from "@/lib/integrations/registry";
import type { ProviderId } from "@/lib/providers/types";

/**
 * POST /api/integrations/[id]/install — pinned install, or uninstall.
 *
 * The request names a provider and an ACTION; it never names a package. The
 * spec comes from the registry and must also be allowlisted (see installer.ts),
 * so a compromised client can at most ask for the exact versions the operator
 * already accepted — five times an hour.
 *
 * Both directions are audited BEFORE the work starts where possible: an install
 * that times out halfway is exactly the case you want a row for. Rate limiting
 * is per user, shared between install and uninstall — it bounds process
 * spawns, not a direction.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time; auth reads the session cookie, so this is request-time already.
 */

const BodySchema = z.object({ action: z.enum(["install", "uninstall"]) });

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }
  if (!sameOrigin(req)) {
    return Response.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  }

  const limit = checkRateLimit(
    { bucket: "install", id: String(decision.user.id) },
    RATE_LIMITS.install,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const { id } = await ctx.params;
  const spec = integrationSpec(id as ProviderId);
  if (!spec) {
    return Response.json({ error: "unknown_provider" }, { status: 404, headers: NO_STORE });
  }

  if (bodyTooLarge(req)) {
    return Response.json({ error: "body_too_large" }, { status: 413, headers: NO_STORE });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }

  const db = getBootDb();
  const userId = String(decision.user.id);
  const ip = clientIp(req);
  const action = parsed.data.action;

  // Start the audit row first: a timed-out install must still be attributable.
  try {
    recordAudit(db, {
      userId,
      action: `integration.${action}.start`,
      detail: { provider: spec.id, spec: spec.installSpec },
      ip,
    });
  } catch {
    // see recordAudit's contract — never let the log block the action
  }

  const outcome =
    action === "install"
      ? await runInstall(spec.id, { allowlist: getEnv().INSTALL_ALLOWLIST })
      : await runUninstall(spec.id);

  try {
    recordAudit(db, {
      userId,
      action: `integration.${action}.${outcome.ok ? "ok" : "failed"}`,
      detail: { provider: spec.id, ...outcome.audit },
      ip,
    });
  } catch {
    /* best effort */
  }

  // The next page load must see the new reality, not the cache's 60-second-old
  // answer. Detection is cheap; a stale "not installed" after a successful
  // install is not.
  invalidateDetection(spec.id);

  if (outcome.code === "refused") {
    return Response.json(
      { error: "install_refused", message: outcome.detail },
      { status: 409, headers: NO_STORE },
    );
  }

  return Response.json(
    { ok: outcome.ok, code: outcome.code, detail: outcome.detail },
    { status: outcome.ok ? 200 : 502, headers: NO_STORE },
  );
}
