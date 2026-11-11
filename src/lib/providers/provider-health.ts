import "server-only";
import { listAdapters } from "./registry";
import type { ProviderId } from "./types";

/**
 * Health snapshot for the Providers/Integrations UI: one entry per enabled,
 * implemented provider, each built from its adapter's own `inventory()`.
 * Deliberately provider-agnostic — no provider-specific fields leak out.
 */

export interface ProviderHealth {
  id: ProviderId;
  installed: boolean;
  /** null = not yet known (no live session has reported). */
  version: string | null;
  /** Tri-state: null = unknown until a live session reports. */
  authed: boolean | null;
  reason: string | null;
  models: { id: string; label: string | null }[];
}

export async function providerHealth(): Promise<ProviderHealth[]> {
  const adapters = listAdapters();
  return Promise.all(adapters.map((a) => a.inventory()));
}
