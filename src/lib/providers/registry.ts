import "server-only";
import { getEnv } from "../env";
import type { ProviderAdapter, ProviderId } from "./types";
import { getClaudeAdapter } from "./claude/adapter";
import { getCodexAdapter } from "./codex/adapter";
import { getOpenCodeAdapter } from "./opencode/adapter";
import { getQoderAdapter } from "./qoder/adapter";

/**
 * Provider registry — the one place that maps ENABLED_PROVIDERS to adapter
 * instances. Everything else resolves adapters through getAdapter(); no
 * feature module ever imports a concrete adapter directly.
 *
 * Adapters are lazy: constructing one must not spawn a CLI or probe the
 * filesystem (each `get*Adapter` caches a singleton that does no I/O at
 * construction). A provider becomes available only when it is BOTH enabled
 * and implemented.
 */

const KNOWN: readonly ProviderId[] = ["claude", "codex", "opencode", "qoder"];

/**
 * Adapters that exist in this build. Kept explicit rather than derived from
 * KNOWN: `isImplemented` is what the Integrations page reports as
 * `adapterAvailable`, and a provider listed in KNOWN without an entry here
 * must read as unavailable instead of failing at session start.
 */
const IMPLEMENTED: readonly ProviderId[] = ["claude", "codex", "opencode", "qoder"];

export function isImplemented(id: ProviderId): boolean {
  return IMPLEMENTED.includes(id);
}

/** Whether ENABLED_PROVIDERS admits this provider at all. */
export function isEnabled(id: ProviderId): boolean {
  return getEnv().ENABLED_PROVIDERS.includes(id);
}

/** Returns the adapter for an enabled, implemented provider, else null. */
export function getAdapter(id: ProviderId | string): ProviderAdapter | null {
  if (!isImplemented(id as ProviderId)) return null;
  if (!isEnabled(id as ProviderId)) return null;
  switch (id) {
    case "claude":
      return getClaudeAdapter();
    case "codex":
      return getCodexAdapter();
    case "opencode":
      return getOpenCodeAdapter();
    case "qoder":
      return getQoderAdapter();
    default:
      return null;
  }
}

/** All enabled+implemented adapters (used by the composer's picker). */
export function listAdapters(): ProviderAdapter[] {
  const out: ProviderAdapter[] = [];
  for (const id of KNOWN) {
    const a = getAdapter(id);
    if (a) out.push(a);
  }
  return out;
}

/** Capability summary for client Components — no adapter internals leak. */
export interface ProviderSummary {
  id: ProviderId;
  capabilities: ProviderAdapter["capabilities"];
}

export function listProviderSummaries(): ProviderSummary[] {
  return listAdapters().map((a) => ({ id: a.id, capabilities: a.capabilities }));
}
