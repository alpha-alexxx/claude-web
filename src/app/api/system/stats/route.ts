import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { systemStats } from "@/lib/system/stats";

/**
 * GET /api/system/stats — one sample of the host's CPU / heap / RSS / disk.
 *
 * Admin-only: these are operator facts about the machine (RAM size, free
 * space), the same audience as the Integrations page. A regular user is
 * answered 403 and the sidebar widget hides itself on that answer — the role
 * never has to be plumbed into the client frame.
 *
 * `no-store` because a cached snapshot is a *log* of the past, and the whole
 * point is the present. The rate limit bounds polling: one tab at 5 s is
 * 12/min, well under the 60/min bucket.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`, and
 * the cookie read in `requireActor` already makes this request-time.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }

  const limit = checkRateLimit(
    { bucket: "system", id: String(decision.user.id) },
    RATE_LIMITS.system,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  return Response.json(systemStats(), { headers: NO_STORE });
}
