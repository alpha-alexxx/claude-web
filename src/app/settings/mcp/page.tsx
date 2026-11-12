import { Suspense } from "react";
import { redirect } from "next/navigation";
import { dirname } from "node:path";
import { currentActor } from "@/lib/auth/current-actor";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import { getEnv } from "@/lib/env";
import { readMcpRegistry } from "@/lib/mcp/store";
import { McpPanel } from "@/components/settings/mcp-panel";

/**
 * /settings/mcp — edit the app's one MCP registry and push it into each tool.
 *
 * The read model is the registry file itself (`data/mcp-servers.json`), read
 * here on the server so the page arrives populated instead of flashing an
 * empty list. `readMcpRegistry` drops entries that no longer validate rather
 * than repairing them, which is the same rule the API applies — a page that
 * showed an invalid row as if it were saved would be lying about what is on
 * disk.
 *
 * Admin-only and redirected, like every other settings section: this writes
 * files in the operator's home directory for every user of the server.
 */
export default function McpSettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<McpSkeleton />}>
        <McpSurface />
      </Suspense>
    </div>
  );
}

async function McpSurface() {
  // Proxy does the cheap redirect; the page still verifies — matcher changes
  // can silently drop Proxy coverage (see current-actor.ts).
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  if (actor.role !== "admin") redirect("/chat");

  const servers = readMcpRegistry(dirname(getEnv().DATABASE_PATH));
  return <McpPanel initialServers={servers} />;
}

function McpSkeleton() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6 h-6 w-40 animate-pulse rounded-md bg-muted" />
      <div className="flex flex-col gap-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
