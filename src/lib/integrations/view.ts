import "server-only";
import path from "node:path";
import { getEnv } from "@/lib/env";
import { getBootDb } from "@/lib/db/boot";
import { listIntegrations, type IntegrationRow } from "@/lib/db/integrations-repo";
import { isEnabled, isImplemented } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";
import { detectAll } from "./detect";
import { credentialStatus } from "./credentials";
import { npmGlobalPrefix } from "./disk";
import { installAllowlist } from "./allowlist";
import { planInstall, resolveNpm } from "./installer";
import { INTEGRATIONS } from "./registry";
import { formatMiB } from "./disk";
import type { IntegrationView, IntegrationsView } from "./types";

/**
 * The Integrations page's read model, assembled server-side so the client
 * never re-derives a gate.
 *
 * Two rules shape the payload:
 *   - credentials are `configured` + key NAMES only (never a value, never a
 *     masked tail — a suffix is still a secret fragment);
 *   - the host's filesystem stays out of it: the absolute binary path is not
 *     sent, only whether it was found and what version it reported.
 *
 * The shapes themselves live in ./types so the client tree can name them
 * without importing this server-only module.
 */

/** The registry pin's version part (`@openai/codex@0.167.0` → `0.167.0`). */
export function pinnedVersionOf(spec: string | null): string | null {
  if (!spec) return null;
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : null;
}

export async function integrationsView(
  options: { refresh?: boolean } = {},
): Promise<IntegrationsView> {
  const env = getEnv();
  const dbPath = env.DATABASE_PATH;
  // Resolve the effective allowlist once and hand it to every plan, so the
  // cards' disabled states and the route's preflight read the same list.
  const allowlist = installAllowlist(env);
  const [detections, rows] = await Promise.all([
    detectAll({ refresh: options.refresh }),
    Promise.resolve(listIntegrations(getBootDb())),
  ]);
  const rowById = new Map<ProviderId, IntegrationRow>(
    rows.map((r) => [r.provider, r]),
  );

  const views: IntegrationView[] = [];
  // `npm prefix -g` is one fact about the host, but `planInstall` would spawn it
  // once per provider — four npm processes per page focus, each racing the
  // detection probes. Memoise it for this view, and only resolve it if a plan
  // actually reaches the disk stage (on a host without npm, or with installs
  // disabled, the answer is a refusal that never needed a prefix).
  const prefixOnce = once(async () => {
    const npm = resolveNpm();
    // Unreachable through `planInstall` (it refuses with `npm_not_found`
    // first), but a doomed spawn would be a poor fallback if it ever were.
    if (!npm) return { dir: path.dirname(env.DATABASE_PATH), resolved: false };
    return npmGlobalPrefix(npm, { fallbackDir: path.dirname(env.DATABASE_PATH) });
  });
  for (const spec of INTEGRATIONS) {
    const detection = detections.find((d) => d.id === spec.id);
    if (!detection) continue;
    const row = rowById.get(spec.id);
    const plan = await planInstall(spec.id, {
      allowlist,
      prefix: async () => (await prefixOnce()).dir,
    });
    const pin = pinnedVersionOf(spec.installSpec);
    const enabled = row?.enabled ?? false;
    const adapterAvailable = isImplemented(spec.id) && isEnabled(spec.id);

    views.push({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      docsUrl: spec.docsUrl,
      authMethod: spec.authMethod,
      sizeLabel: spec.diskBytes === 0 ? "bundled" : formatMiB(spec.diskBytes),
      status: detection.status,
      version: detection.version,
      drift: Boolean(
        pin && detection.version && detection.version !== pin && detection.status === "installed",
      ),
      statusReason: detection.reason,
      enabled,
      adapterAvailable,
      active: enabled && adapterAvailable,
      credentials: credentialStatus(dbPath, spec.id),
      credentialKeys: spec.credentialKeys,
      install: {
        spec: spec.installSpec,
        allowed: plan.refusal === null,
        refusal: plan.refusal,
        reason: plan.reason,
        freeLabel:
          plan.disk && plan.disk.freeBytes > 0 ? formatMiB(plan.disk.freeBytes) : null,
      },
    });
  }

  const known = new Set(INTEGRATIONS.map((s) => s.installSpec).filter(Boolean));
  const unknown = allowlist.filter((s) => !known.has(s));

  return {
    integrations: views,
    installsEnabled: allowlist.length > 0,
    allowlistWarning:
      unknown.length > 0
        ? `INSTALL_ALLOWLIST names ${unknown.join(", ")}, which this app does not install`
        : null,
  };
}

/** Memoise an async call for the lifetime of one caller's scope. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= fn();
    return pending;
  };
}
