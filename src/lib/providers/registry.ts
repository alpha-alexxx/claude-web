import "server-only";
import { getEnv } from "../env";
import type { ProviderAdapter, ProviderId } from "./types";
import { getClaudeAdapter } from "./claude/adapter";

/**
 * Provider registry — the one place that maps ENABLED_PROVIDERS to adapter
 * instances. Everything else resolves adapters through getAdapter(); no
 * feature module ever imports a concrete adapter directly.
 *
 * Adapters are lazy: constructing one must not spawn a CLI or probe the
 * filesystem. A provider becomes available only when it is BOTH enabled and
 * implemented (codex/opencode/qoder land incrementally and are refused
 * here until their adapter exists).
 */

const KNOWN: readonly ProviderId[] = ["claude", "codex", "opencode", "qoder"];

/**
 * Adapters that exist in this build. The others are listed by Integrations
 * (so an operator can install the CLI ahead of the adapter) but never
 * activated — a UI that offers a backend it cannot drive is worse than one
 * that says "not available yet".
 */
const IMPLEMENTED: readonly ProviderId[] = ["claude"];

export function isImplemented(id: ProviderId): boolean {
  return IMPLEMENTED.includes(id);
}

/** Whether ENABLED_PROVIDERS admits this provider at all. */
export function isEnabled(id: ProviderId): boolean {
  return getEnv().ENABLED_PROVIDERS.includes(id);
}

/** Returns the adapter for an enabled, implemented provider, else null. */
export function getAdapter(id: ProviderId | string): ProviderAdapter | null {
  const enabled = getEnv().ENABLED_PROVIDERS;
  if (!enabled.includes(id as ProviderId)) return null;
  if (id === "claude") return getClaudeAdapter();
  // codex / opencode / qoder: adapters land incrementally (plan's adapter
  // build order). Until then they stay refused even when enabled.
  return null;
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
