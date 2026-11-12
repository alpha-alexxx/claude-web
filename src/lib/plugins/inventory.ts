/**
 * Plugin inventory: a unified list across tools whose manifests are four
 * incompatible conventions.
 *
 * What this module will NOT do is pretend portability. `.claude-plugin/`,
 * Codex's `plugin.json`, OpenCode's JS plugins and Qoder's `.qoder-plugin/`
 * have no common schema, and no CLI reads another's directory. So the list
 * carries a `compatibleWith` label derived from the manifests actually present
 * — and an unrecognised layout claims nothing rather than guessing.
 *
 * Install/uninstall is not implemented here: it belongs to each tool's own CLI
 * (`claude plugin install …`), driven with argv arrays from the route layer.
 * This module only reads and normalises what those CLIs report.
 */

export type PluginProvider = "claude" | "codex" | "opencode" | "qoder";

export type PluginScope = "user" | "project" | "local" | "unknown";

/** One plugin as one provider reports it. */
export interface PluginRecord {
  /** Stable identity inside a provider, e.g. `name@marketplace`. */
  id: string;
  name: string;
  marketplace: string | null;
  version: string | null;
  scope: PluginScope;
  enabled: boolean;
  provider: PluginProvider;
  /** Informational only — the manager never reads inside it. */
  installPath: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
}

/** Which tools' manifest conventions a plugin directory actually contains. */
export interface PluginManifestSet {
  claude?: boolean;
  codex?: boolean;
  opencode?: boolean;
  qoder?: boolean;
}

export interface UnifiedPlugin extends PluginRecord {
  /** Tools whose manifest convention this plugin follows. Empty = unknown. */
  compatibleWith: PluginProvider[];
}

const SCOPES = new Set<PluginScope>(["user", "project", "local"]);

/**
 * Parse `claude plugin list --json`. Total: junk, an empty string, or an object
 * where an array was expected yields `[]`. Entries without a usable `id` are
 * dropped — inventing an identity would make enable/disable target the wrong
 * thing, which is worse than not listing it.
 */
export function parseClaudePluginList(raw: string | unknown): PluginRecord[] {
  const data = typeof raw === "string" ? tryParse(raw) : raw;
  if (!Array.isArray(data)) return [];

  const records: PluginRecord[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "") continue;

    const at = id.lastIndexOf("@");
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : null;

    const scopeRaw = typeof record.scope === "string" ? record.scope : "";
    records.push({
      id,
      name,
      marketplace,
      version: str(record.version),
      scope: SCOPES.has(scopeRaw as PluginScope)
        ? (scopeRaw as PluginScope)
        : "unknown",
      enabled: record.enabled === true,
      provider: "claude",
      installPath: str(record.installPath),
      installedAt: str(record.installedAt),
      lastUpdated: str(record.lastUpdated),
    });
  }
  return records;
}

/**
 * The compat label for one plugin. Only conventions actually present count;
 * an unrecognised layout returns `[]`, which the UI renders as "compatibility
 * unknown" rather than as a false claim.
 */
export function pluginCompat(manifests: PluginManifestSet): PluginProvider[] {
  const tools: PluginProvider[] = [];
  if (manifests.claude) tools.push("claude");
  if (manifests.codex) tools.push("codex");
  if (manifests.opencode) tools.push("opencode");
  if (manifests.qoder) tools.push("qoder");
  return tools;
}

/**
 * Merge per-provider records into the one list the page renders. `manifestsFor`
 * is injected because determining a manifest set means reading a directory, and
 * this function should stay pure and testable.
 */
export function unifiedPlugins(input: {
  [K in PluginProvider]?: PluginRecord[];
} & {
  manifestsFor: (plugin: PluginRecord) => PluginManifestSet;
}): UnifiedPlugin[] {
  const providers: PluginProvider[] = ["claude", "codex", "opencode", "qoder"];
  const all: UnifiedPlugin[] = [];

  for (const provider of providers) {
    for (const record of input[provider] ?? []) {
      all.push({
        ...record,
        // The provider listing it is authoritative for its own compat.
        compatibleWith: pluginCompat(
          input.manifestsFor({ ...record, provider }),
        ),
      });
    }
  }

  return all.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      a.provider.localeCompare(b.provider),
  );
}

// -- internals ---------------------------------------------------------------

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
