import { requireActor } from "@/lib/auth/current-actor";
import { pluginsView } from "@/lib/plugins/view";

/**
 * GET /api/plugins — the unified plugin list.
 *
 * Admin-only: it reflects the plugins installed for this host's user, which is
 * operator state. Spawning `claude plugin list` per focus would be a process
 * per page refresh, so the client caches the result for the visit.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
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

  return Response.json(await pluginsView(), { headers: NO_STORE });
}
