import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { recordIntegrationCheck } from "@/lib/db/integrations-repo";
import { getEnv } from "@/lib/env";
import {
  clearCredentials,
  credentialStatus,
  writeCredentials,
} from "@/lib/integrations/credentials";
import { integrationSpec } from "@/lib/integrations/registry";
import type { ProviderId } from "@/lib/providers/types";

/**
 * POST /api/integrations/[id]/auth — enter or clear credentials.
 *
 * The body is a map of declared KEY → value. Keys are validated against the
 * provider's own list (credentials.ts refuses anything else), so a client
 * cannot use this endpoint as a general-purpose secret writer.
 *
 * The response is ALWAYS the names-only status. Values never come back — not
 * masked, not truncated: a suffix is still a secret. The audit row records
 * which keys were set, never their content.
 *
 * Rate-limited on the install bucket: both are privileged writes on the same
 * budget, and a credential endpoint without a limit is a brute-force target
 * for nothing, but a way to spin the audit log.
 *
 * Claude is refused: it uses the host login (no ANTHROPIC_API_KEY passthrough
 * — ledgered, that would silently outrank the subscription credential).
 *
 * No segment config: auth reads the session cookie.
 */

const BodySchema = z.object({
  /** `{ OPENAI_API_KEY: "sk-…" }`, or `{}` to clear the provider's keys. */
  values: z.record(z.string().min(1).max(128), z.string().max(4096)).default({}),
  clear: z.boolean().optional(),
});

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(
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

  const limit = checkRateLimit(
    { bucket: "install", id: String(decision.user.id) },
    RATE_LIMITS.install,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const { id } = await ctx.params;
  const spec = integrationSpec(id as ProviderId);
  if (!spec) {
    return Response.json({ error: "unknown_provider" }, { status: 404, headers: NO_STORE });
  }

  // Credential values are individually bounded to 4096 chars, but the record
  // itself is unbounded keys × values — declare the small-mutation ceiling
  // before buffering.
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

  const dbPath = getEnv().DATABASE_PATH;
  const db = getBootDb();
  const userId = String(decision.user.id);
  const ip = clientIp(req);

  if (spec.credentialKeys.length === 0) {
    return Response.json(
      {
        error: "no_credentials",
        message: `${spec.label} uses this host's own login — there is nothing to enter`,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  let keysWritten: string[] = [];
  if (parsed.data.clear) {
    clearCredentials(dbPath, spec.id);
  } else {
    const written = writeCredentials(dbPath, spec.id, parsed.data.values);
    if (!written.ok) {
      const status = written.error === "unknown_provider" ? 404 : 400;
      return Response.json(
        {
          error: written.error,
          message:
            written.error === "invalid"
              ? `Expected single-line values for: ${spec.credentialKeys.join(", ")}`
              : undefined,
        },
        { status, headers: NO_STORE },
      );
    }
    keysWritten = Object.keys(parsed.data.values);
  }

  const status = credentialStatus(dbPath, spec.id);
  recordIntegrationCheck(db, spec.id, { version: null, authed: status.configured });

  try {
    recordAudit(db, {
      userId,
      action: parsed.data.clear ? "integration.auth.clear" : "integration.auth.set",
      // Key NAMES only. This is the audit row's whole point: "who added a
      // credential, for which provider" — the value is never a record.
      detail: { provider: spec.id, keys: keysWritten.sort() },
      ip,
    });
  } catch {
    /* best effort */
  }

  return Response.json({ ok: true, credentials: status }, { headers: NO_STORE });
}
