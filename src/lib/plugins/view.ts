import "server-only";
import { readdirSync } from "node:fs";
import { listClaudePlugins, type PluginRunner } from "./runner";
import {
  unifiedPlugins,
  type PluginManifestSet,
  type PluginProvider,
  type PluginRecord,
} from "./inventory";
import type { PluginsView } from "./types";

/**
 * The Plugins page's read model.
 *
 * Claude is the only provider with a machine-readable inventory (`claude
 * plugin list --json`), and the only one whose plugins this build can actually
 * enable/disable. The others are still listed so the page can say plainly
 * "not implemented in this build", rather than showing an empty list that
 * reads as "no plugins".
 */

export const PLUGIN_PROVIDERS: PluginsView["providers"] = [
  { id: "claude", label: "Claude Code", inventory: true },
  { id: "codex", label: "Codex", inventory: false },
  { id: "opencode", label: "OpenCode", inventory: false },
  { id: "qoder", label: "Qoder", inventory: false },
];

/**
 * Which manifest conventions a plugin's install directory declares. Read-only
 * and best-effort: an unreadable installPath falls back to Claude, which is
 * the provider that listed it.
 */
export function manifestsAt(
  installPath: string | null,
  readdir: (p: string) => string[] = safeReaddir,
): PluginManifestSet {
  if (!installPath) return { claude: true };
  const entries = readdir(installPath);
  return {
    claude: entries.includes(".claude-plugin"),
    codex: entries.includes(".codex-plugin"),
    opencode: entries.includes(".opencode-plugin"),
    qoder: entries.includes(".qoder-plugin"),
  };
}

export async function pluginsView(runner?: PluginRunner): Promise<PluginsView> {
  const claude = await listClaudePlugins(runner);
  const byProvider: Partial<Record<PluginProvider, PluginRecord[]>> = {
    claude: claude.plugins,
  };

  return {
    plugins: unifiedPlugins({
      ...byProvider,
      manifestsFor: (plugin) => manifestsAt(plugin.installPath),
    }),
    message: claude.message,
    providers: PLUGIN_PROVIDERS,
  };
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}
