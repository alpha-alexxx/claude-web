import { Suspense } from "react";
import { redirect } from "next/navigation";
import { homedir } from "node:os";
import { currentActor } from "@/lib/auth/current-actor";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import {
  SETTINGS_TARGETS,
  readSettingsFile,
  type ToolSettingsTarget,
} from "@/lib/settings/files";
import { SETTINGS_TOOL_LABELS, type SettingsTool } from "@/lib/settings/types";
import { ToolSettingsPanel } from "@/components/settings/tool-settings-panel";

/**
 * The body of all four per-tool settings pages, which differ only in `tool`.
 *
 * Server Component, so the file is read on the request rather than fetched by
 * the browser: the read is already redacted by `readSettingsFile`, and routing
 * it through the API would mean a blank editor for one round trip.
 *
 * The frame/Suspense split is the `cacheComponents` rule, same as every other
 * page here: the surface reads the session cookie, which cannot happen in a
 * prerendered frame.
 *
 * Non-admins are redirected rather than shown a 403 — this is navigation, and
 * the file belongs to the operator. The API still refuses them directly.
 */
export function ToolSettingsPage({ tool }: { tool: SettingsTool }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<ToolSettingsSkeleton tool={tool} />}>
        <ToolSettingsSurface tool={tool} />
      </Suspense>
    </div>
  );
}

async function ToolSettingsSurface({ tool }: { tool: SettingsTool }) {
  // Proxy does the cheap redirect; the page still verifies — matcher changes
  // can silently drop Proxy coverage (see current-actor.ts).
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  if (actor.role !== "admin") redirect("/chat");

  const target: ToolSettingsTarget = SETTINGS_TARGETS[tool];
  const settings = readSettingsFile(homedir(), target);
  return <ToolSettingsPanel tool={tool} initialSettings={settings} />;
}

function ToolSettingsSkeleton({ tool }: { tool: SettingsTool }) {
  return (
    <div aria-hidden className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-2 h-6 w-52 animate-pulse rounded-md bg-muted" />
      <p className="sr-only">{SETTINGS_TOOL_LABELS[tool]} settings loading</p>
      <div className="mb-6 h-4 w-80 animate-pulse rounded-md bg-muted/60" />
      <div className="h-[24rem] animate-pulse rounded-xl bg-muted/60" />
    </div>
  );
}
