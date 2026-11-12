import type { PluginsView } from "@/lib/plugins/types";
import { asRecord, getJson, sendJson, type ApiFailure } from "./api";

/**
 * Browser transport for the Plugins page.
 *
 * The list comes from `claude plugin list --json` on the server. Toggling is
 * `POST /api/plugins/[id]` with an explicit `{ enabled }`. Only Claude has a
 * machine-readable inventory in this build; the view says which providers do.
 *
 * An id is passed through `encodeURIComponent` because it is `name@marketplace`
 * and `@` is legal in a path segment but need not survive a proxy unchanged.
 */

export type PluginsResult = { ok: true; view: PluginsView } | ApiFailure;

export type PluginActionOutcome = { ok: true } | ApiFailure;

export async function getPlugins(
  opts: { fetch?: typeof fetch } = {},
): Promise<PluginsResult> {
  const result = await getJson("/api/plugins", opts.fetch);
  if (!result.ok) return result;

  const body = asRecord(result.body);
  if (!body || !Array.isArray(body.plugins) || !Array.isArray(body.providers)) {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, view: body as unknown as PluginsView };
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  opts: { fetch?: typeof fetch } = {},
): Promise<PluginActionOutcome> {
  const result = await sendJson(
    `/api/plugins/${encodeURIComponent(id)}`,
    "POST",
    { enabled },
    opts.fetch,
  );
  return result.ok ? { ok: true } : result;
}
