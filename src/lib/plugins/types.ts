import type { PluginProvider, UnifiedPlugin } from "./inventory";

/**
 * Wire contract for the Plugins page. Plain module — no `server-only` — so the
 * Client Component tree can name these shapes without pulling the CLI runner
 * into the browser bundle.
 */

export type { PluginProvider, UnifiedPlugin };

export interface PluginsView {
  plugins: UnifiedPlugin[];
  /** Why the list is empty, when it is empty for a reason worth showing. */
  message: string | null;
  /** Providers in this build, in display order. */
  providers: { id: PluginProvider; label: string; inventory: boolean }[];
}

export interface PluginActionOutcome {
  ok: boolean;
  code: string;
  message?: string;
}
