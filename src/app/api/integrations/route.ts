import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { integrationsView } from "@/lib/integrations/view";

/**
 * GET /api/integrations — the Integrations page's data.
 *
 * Admin-only: the payload reveals which CLIs exist on this host, their
 * versions, and how much disk is free — operator information. A regular user
 * gets the provider list they can actually chat with from /api/bootstrap.
 *
 * `?refresh=1` bypasses the detection cache (the page's "Check again"). It is
 * a read: refreshing spawns `--version` probes, but changes no state, so it
 * stays a GET. Because it is the one read here that starts processes, the
 * bucket is sized to allow the page's focus refetch while still bounding an
 * unattended tab or a scripted loop.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time; `requireActor` reads the session cookie, which keeps this
 * request-time already.
 */

export async function GET(req: Request): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }

  const limit = checkRateLimit(
    { bucket: "integrations", id: String(decision.user.id) },
    RATE_LIMITS.integrations,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(limit.retryAfterSec),
        },
      },
    );
  }

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const view = await integrationsView({ refresh });

  return Response.json(view, {
    // Per-host facts that change as soon as anything is installed; never cached.
    headers: { "cache-control": "no-store" },
  });
}
