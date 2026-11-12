import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import {
  findIntegration,
  setIntegrationEnabled,
} from "@/lib/db/integrations-repo";
import { getEnv } from "@/lib/env";
import { detectOne } from "@/lib/integrations/detect";
import { credentialStatus } from "@/lib/integrations/credentials";
import { integrationSpec } from "@/lib/integrations/registry";
import { isEnabled } from "@/lib/providers/registry";
import type { ProviderId } from "@/lib/providers/types";

/**
 * PATCH /api/integrations/[id] — enable or disable one provider.
 *
 * Enabling is gated on three facts, checked in this order: the provider is
 * listed in ENABLED_PROVIDERS, its binary is detected, and it has credentials.
 * An integration switched on without any of them is a chat surface that fails
 * on the first message with a spawn error far from the cause. Each refusal
 * names the missing step.
 *
 * For providers with no adapter in this build, `enabled` is still recorded —
 * it is operator intent, and the Integrations card explains that the adapter
 * has not landed — but chat will not offer it (getAdapter refuses it).
 *
 * Disabling is deliberately ungated: it only ever removes a capability, so a
 * provider that became broken (binary deleted, credentials cleared) must still
 * be switchable off.
 *
 * Claude is refused here outright: it is enabled by ENABLED_PROVIDERS and
 * needs no install; a DB toggle would only contradict the env.
 */

const BodySchema = z.object({ enabled: z.boolean() });

const NO_STORE = { "cache-control": "no-store" } as const;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }
  if (!sameOrigin(req)) {
    return Response.json({ error: "cross_origin" }, { status: 403, headers: NO_STORE });
  }

  const { id } = await ctx.params;
  const spec = integrationSpec(id as ProviderId);
  if (!spec) {
    return Response.json({ error: "unknown_provider" }, { status: 404, headers: NO_STORE });
  }
  if (spec.bin === null) {
    return Response.json(
      {
        error: "not_toggleable",
        message: `${spec.label} is controlled by ENABLED_PROVIDERS and needs no toggle`,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  if (bodyTooLarge(req)) {
    return Response.json({ error: "body_too_large" }, { status: 413, headers: NO_STORE });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
  }
  const enabled = parsed.data.enabled;

  const env = getEnv();
  const db = getBootDb();

  if (enabled) {
    if (!isEnabled(spec.id)) {
      return Response.json(
        {
          error: "not_in_enabled_providers",
          message: `Add "${spec.id}" to ENABLED_PROVIDERS and restart to activate it`,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    const detection = await detectOne(spec, {});
    // `broken` (on PATH but will not run) refuses exactly like `missing`: both
    // mean spawning this provider fails, and the difference is already in the
    // message the operator reads.
    if (detection.status !== "installed") {
      return Response.json(
        {
          error: "not_installed",
          message: detection.reason ?? `${spec.label} is not installed`,
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (!credentialStatus(env.DATABASE_PATH, spec.id).configured) {
      return Response.json(
        {
          error: "not_authenticated",
          message: `${spec.label} has no credentials yet — add one under Authentication first`,
        },
        { status: 409, headers: NO_STORE },
      );
    }
  }

  setIntegrationEnabled(db, spec.id, enabled);
  try {
    recordAudit(db, {
      userId: String(decision.user.id),
      action: enabled ? "integration.enable" : "integration.disable",
      detail: { provider: spec.id },
      ip: clientIp(req),
    });
  } catch {
    // The toggle is already durable; a failed audit must not undo it.
  }

  return Response.json(
    { ok: true, enabled, row: findIntegration(db, spec.id) },
    { headers: NO_STORE },
  );
}
