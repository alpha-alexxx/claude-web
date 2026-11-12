import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { pluginsView } from "@/lib/plugins/view";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import { PluginsPanel } from "@/components/plugins/plugins-panel";

/**
 * /plugins — the unified plugin list across tools.
 *
 * Split like every other page under `cacheComponents`: a prerendered frame and
 * a request-time <PluginsSurface> inside <Suspense>, because the surface reads
 * the session cookie.
 *
 * The read model comes from `pluginsView`, which shells out to `claude plugin
 * list --json` — the one CLI in this build with a machine-readable inventory.
 * That call never throws: a missing binary or malformed output becomes an
 * empty list plus a `message`, which the panel shows. An empty page that says
 * why is the honest version of "you have no plugins".
 *
 * Non-admins are redirected: plugins are host-wide state, installed and
 * enabled for every user of this server.
 */
export default function PluginsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<PluginsSkeleton />}>
        <PluginsSurface />
      </Suspense>
    </div>
  );
}

async function PluginsSurface() {
  // Proxy does the cheap redirect; the page still verifies — matcher changes
  // can silently drop Proxy coverage (see current-actor.ts).
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  if (actor.role !== "admin") redirect("/chat");

  const view = await pluginsView();
  return <PluginsPanel initialView={view} />;
}

function PluginsSkeleton() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 h-6 w-36 animate-pulse rounded-md bg-muted" />
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
