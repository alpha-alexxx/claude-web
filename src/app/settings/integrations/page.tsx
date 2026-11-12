import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { integrationsView } from "@/lib/integrations/view";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import { IntegrationsPanel } from "@/components/settings/integrations-panel";

/**
 * /settings/integrations — the admin surface for the coding-agent CLIs.
 *
 * Server Component, split the same way as /chat: a prerendered page frame and
 * a request-time <IntegrationsSurface> inside <Suspense>, because it reads the
 * session cookie. Reading the cookie outside a boundary is a build error
 * under `cacheComponents`, not a hint.
 *
 * The read model is assembled HERE, on the server, by the same function
 * /api/integrations serves: the client receives rendered facts (sizes, gate
 * reasons, names-only credential status) and never host paths or secret
 * values. Client-side mutations refetch that same endpoint afterwards, so the
 * page has exactly one implementation of every gate.
 *
 * Non-admins are redirected, not 403'd: a page is a navigation, and the
 * providers they may use are already listed in the composer. The API still
 * answers 403 for anything that calls it directly.
 */
export default function IntegrationsSettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<IntegrationsSkeleton />}>
        <IntegrationsSurface />
      </Suspense>
    </div>
  );
}

async function IntegrationsSurface() {
  // Proxy does the cheap redirect; the page still verifies — matcher changes
  // can silently drop Proxy coverage (see current-actor.ts).
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  if (actor.role !== "admin") redirect("/chat");

  const view = await integrationsView();
  return <IntegrationsPanel initialView={view} />;
}

function IntegrationsSkeleton() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 h-6 w-48 animate-pulse rounded-md bg-muted" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
