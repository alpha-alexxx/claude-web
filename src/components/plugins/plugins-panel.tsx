"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getPlugins, setPluginEnabled } from "@/lib/client/plugins-client";
import type { PluginsView, UnifiedPlugin } from "@/lib/plugins/types";
import { TOOL_LABELS, TOOL_IDS, type ToolId } from "@/lib/tools";

/**
 * PluginsPanel: the unified plugin list.
 *
 * The list is honest about what it is. Plugin manifests are four incompatible
 * conventions and no CLI reads another's directory, so a row carries a
 * compatibility label derived from the directories actually present — and
 * says "unknown" rather than guessing when none match. Only Claude has a
 * machine-readable inventory in this build; the header says so, and the row
 * toggle is only offered for the provider that can act on it.
 *
 * Enable/disable runs `claude plugin <enable|disable> <id>` on the server and
 * refetches. Nothing about a plugin is cached here: the CLI is the source of
 * truth, and its view of `enabled` may change out from under the page.
 */

export interface PluginsPanelProps {
  initialView: PluginsView;
}

export function PluginsPanel({ initialView }: PluginsPanelProps) {
  const [view, setView] = useState(initialView);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const result = await getPlugins();
    if (seq !== refreshSeq.current) return;
    if (result.ok) setView(result.view);
    else toast.error("Could not reload the plugin list.");
  }, []);

  const checkAgain = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const toggle = useCallback(
    async (plugin: UnifiedPlugin, enabled: boolean) => {
      setPendingId(plugin.id);
      try {
        const outcome = await setPluginEnabled(plugin.id, enabled);
        if (!outcome.ok) {
          toast.error(
            outcome.message ??
              describeFailure(outcome.code, enabled ? "enable" : "disable"),
          );
          return;
        }
        toast.success(
          `${plugin.name} ${enabled ? "enabled" : "disabled"}`,
        );
        await reload();
      } finally {
        setPendingId(null);
      }
    },
    [reload],
  );

  const inventoryProviders = view.providers.filter((p) => p.inventory);
  const silentProviders = view.providers.filter((p) => !p.inventory);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-xl leading-tight">Plugins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every plugin this server can see, across the tools that report them.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={checkAgain}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Check again"}
        </Button>
      </header>

      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        {inventoryProviders.length > 0 ? (
          <>
            Listed from{" "}
            {inventoryProviders.map((p) => p.label).join(", ")}.
          </>
        ) : (
          "No provider in this build reports a plugin inventory."
        )}{" "}
        {silentProviders.length > 0 && (
          <>
            {silentProviders.map((p) => p.label).join(", ")}{" "}
            {silentProviders.length === 1 ? "has" : "have"} no machine-readable
            inventory here, so their plugins are not listed.
          </>
        )}
      </p>

      {view.message && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {view.message}
        </p>
      )}

      {view.plugins.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">No plugins installed</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Install one with your agent CLI, for example{" "}
            <code className="font-mono text-xs">
              claude plugin install &lt;name&gt;@&lt;marketplace&gt;
            </code>
            . It will appear here after you check again.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.plugins.map((plugin) => (
            <li key={`${plugin.provider}:${plugin.id}`}>
              <PluginRow
                plugin={plugin}
                busy={pendingId === plugin.id}
                onToggle={(enabled) => void toggle(plugin, enabled)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeFailure(code: string, action: string): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many plugin changes. Wait a moment before trying again.";
    case "cli_missing":
      return "The Claude CLI is not installed on this server.";
    case "cli_failed":
      return `The CLI could not ${action} that plugin.`;
    case "forbidden":
      return "You need admin access to change plugins.";
    default:
      return "That did not work. Try again.";
  }
}

function PluginRow({
  plugin,
  busy,
  onToggle,
}: {
  plugin: UnifiedPlugin;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  // Only Claude's CLI can enable/disable by id in this build. Showing a dead
  // switch on the other providers would imply an action that does not exist.
  const toggleable = plugin.provider === "claude";

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-sm font-medium">{plugin.name}</h2>
            {plugin.version && (
              <span className="font-mono text-[11px] text-muted-foreground">
                v{plugin.version}
              </span>
            )}
            <Badge variant={plugin.enabled ? "secondary" : "outline"}>
              {plugin.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>

          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {plugin.marketplace
              ? `${plugin.marketplace} · ${plugin.id}`
              : plugin.id}
          </p>

          <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <div className="flex items-center gap-1">
              <dt className="text-muted-foreground">Scope</dt>
              <dd>
                <Badge variant="outline">{plugin.scope}</Badge>
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="text-muted-foreground">Runs in</dt>
              <dd>
                <CompatLabel compatibleWith={plugin.compatibleWith} />
              </dd>
            </div>
          </dl>
        </div>

        {toggleable ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {busy ? "Working…" : "Enabled"}
            </span>
            <Switch
              checked={plugin.enabled}
              disabled={busy}
              onCheckedChange={onToggle}
              aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
            />
          </div>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground">
            Manage with {TOOL_LABELS[plugin.provider as ToolId] ?? plugin.provider}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The compatibility label. An empty list means no manifest convention this
 * build recognises, and saying so is better than naming a tool that will not
 * actually load the plugin.
 */
function CompatLabel({ compatibleWith }: { compatibleWith: UnifiedPlugin["compatibleWith"] }) {
  const known = TOOL_IDS.filter((id) => compatibleWith.includes(id));
  if (known.length === 0) {
    return <Badge variant="outline">Unknown</Badge>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {known.map((id) => (
        <Badge key={id} variant="outline">
          {TOOL_LABELS[id]}
        </Badge>
      ))}
    </span>
  );
}
