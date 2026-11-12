import "server-only";
import { getEnv } from "@/lib/env";
import { providerHealth } from "@/lib/providers/provider-health";
import { listProviderSummaries } from "@/lib/providers/registry";
import type { ChatBootstrap } from "@/lib/client/chat-state";

/**
 * The payload every chat surface needs before it can render a composer:
 * the workspace roots, the default model, and the providers that are BOTH
 * enabled and implemented (with their inventory joined in).
 *
 * Shared by /chat and /chat/[id] instead of each page composing it: a
 * provider enabled but missing an adapter is dropped here — the composer can
 * never offer a provider the registry would refuse.
 */
export async function loadChatBootstrap(): Promise<ChatBootstrap> {
  const env = getEnv();
  const [health, summaries] = await Promise.all([
    providerHealth(),
    Promise.resolve(listProviderSummaries()),
  ]);
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
  return {
    roots: env.ALLOWED_WORKSPACE_ROOTS,
    defaultModel: env.DEFAULT_MODEL,
    providers,
  };
}
