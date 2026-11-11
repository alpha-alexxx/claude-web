import { requireActor } from "@/lib/auth/current-actor";
import { providerHealth } from "@/lib/providers/provider-health";

/**
 * GET /api/health — provider inventory for the signed-in user.
 *
 * Auth-gated rather than public: the payload reveals which agent CLIs are
 * installed and how they authenticate on this host, which is operator
 * information, not marketing. Clients cache nothing (`no-store`) because
 * `authed` changes as soon as the first session reports its init frame.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time; `requireActor` reads the cookie, which is a request-time API and
 * already keeps this handler out of the prerender.
 */

export async function GET(): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }
  const providers = await providerHealth();
  return Response.json(
    { providers },
    { headers: { "cache-control": "no-store" } },
  );
}
