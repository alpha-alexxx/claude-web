import { requireActor } from "@/lib/auth/current-actor";
import { getEnv } from "@/lib/env";
import { providerHealth } from "@/lib/providers/provider-health";
import { listProviderSummaries } from "@/lib/providers/registry";

/**
 * GET /api/bootstrap — everything the chat surface needs on first load:
 * workspace roots for the cwd picker, enabled providers with their declared
 * capabilities and model lists, and the default model.
 *
 * One call instead of three keeps the shell from waterfalling on mount.
 * Auth-gated and no-store: roots are host filesystem paths, and provider
 * inventory changes as soon as a session reports. Env is read server-side
 * only; the payload carries the derived roots, never the raw env.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }

  const env = getEnv();
  const [health, summaries] = await Promise.all([
    providerHealth(),
    Promise.resolve(listProviderSummaries()),
  ]);

  // Join inventory (installed/authed/models) with capabilities by provider id.
  // A provider missing from `health` is enabled but has no adapter yet — it is
  // not offered to the composer at all (registry refuses it too).
  const providers = summaries.flatMap((s) => {
    const inv = health.find((h) => h.id === s.id);
    return inv
      ? [
          {
            id: s.id,
            capabilities: s.capabilities,
            installed: inv.installed,
            version: inv.version,
            authed: inv.authed,
            reason: inv.reason,
            models: inv.models,
          },
        ]
      : [];
  });

  return Response.json(
    {
      roots: env.ALLOWED_WORKSPACE_ROOTS,
      defaultModel: env.DEFAULT_MODEL,
      providers,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
