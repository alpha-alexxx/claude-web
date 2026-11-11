import "server-only";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { getEnv } from "@/lib/env";
import { providerHealth } from "@/lib/providers/provider-health";
import { listProviderSummaries } from "@/lib/providers/registry";
import { ChatColumn } from "@/components/chat/chat-column";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import type { ChatBootstrap } from "@/lib/client/chat-state";

/**
 * /chat — the chat surface.
 *
 * The page is a Server Component: it assembles the bootstrap payload here by
 * calling the same server modules /api/bootstrap composes (no self-fetch —
 * an internal hop would need a cookie pass-through and add latency for
 * nothing), then hands it to the client ChatColumn.
 *
 * Auth: /chat is a PROTECTED_ROOT, so the Proxy redirects signed-out users
 * to sign-in before this renders. (API routes authenticate themselves;
 * pages rely on the Proxy for the redirect only.)
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. Instead the layout is split in two — a static shell (the page
 * frame, prerendered) and `<ChatSurface>` inside `<Suspense>`, which reads the
 * session cookie and streams at request time. Reading the cookie outside a
 * boundary is a build error, not a hint: the whole route would lose its
 * prerendered shell.
 */

async function loadBootstrap(): Promise<ChatBootstrap> {
  const env = getEnv();
  const [health, summaries] = await Promise.all([
    providerHealth(),
    Promise.resolve(listProviderSummaries()),
  ]);
  // Join by id; a provider enabled but missing an adapter is dropped —
  // the composer can never offer a provider the registry would refuse.
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

export default function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<ChatSurfaceSkeleton />}>
        <ChatSurface />
      </Suspense>
    </div>
  );
}

/** Request-time half: auth, then the bootstrap payload. */
async function ChatSurface() {
  // Proxy does the cheap redirect; each server component still verifies —
  // matcher changes can silently drop Proxy coverage (ledgered Phase 2c).
  if (!(await currentActor())) redirect(SIGN_IN_URL);
  const bootstrap = await loadBootstrap();
  return bootstrap.providers.length === 0 ? (
    <div className="flex flex-1 items-center justify-center p-8">
      <p className="max-w-md text-center text-muted-foreground">
        No provider is available (ENABLED_PROVIDERS has no working adapter).
        Set <code className="font-mono">ENABLED_PROVIDERS=claude</code> and
        restart the server.
      </p>
    </div>
  ) : (
    <ChatColumn bootstrap={bootstrap} />
  );
}

/**
 * Prerendered while the session is verified. Deliberately bare: a spinner
 * would flash for one round trip and read as a second, slower load.
 */
function ChatSurfaceSkeleton() {
  return <div className="flex-1" aria-hidden />;
}
