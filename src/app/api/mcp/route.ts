import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge, BODY_CAPS } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { getEnv } from "@/lib/env";
import { mcpServerSchema } from "@/lib/mcp/registry";
import { readMcpRegistry, writeMcpRegistry } from "@/lib/mcp/store";
import { dirname } from "node:path";

/**
 * GET  /api/mcp — the app's registry (the list the UI edits).
 * PUT  /api/mcp — replace it. Writing the registry does NOT touch any tool's
 *                 config; that is a separate, audited sync (POST …/sync) so a
 *                 typo in the editor cannot rewrite four files at once.
 *
 * Admin-only: the registry is host-wide operator state.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
 */

const BodySchema = z.object({
  servers: z.array(mcpServerSchema).max(64),
});

const NO_STORE = { "cache-control": "no-store" } as const;

/** `data/` lives next to the database file — one place, not two. */
function dataDir(): string {
  return dirname(getEnv().DATABASE_PATH);
}

export async function GET(): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }
  return Response.json({ servers: readMcpRegistry(dataDir()) }, { headers: NO_STORE });
}

export async function PUT(req: Request): Promise<Response> {
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
    { bucket: "mcp", id: String(decision.user.id) },
    { max: 30, windowMs: 60_000 },
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  // A registry document, so the general cap: 64 servers with arguments can
  // legitimately run to hundreds of KB.
  if (bodyTooLarge(req, BODY_CAPS.general)) {
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
    // Name the offending server: "invalid body" on a 20-row form is useless.
    const issue = parsed.error.issues[0];
    return Response.json(
      { error: "invalid_body", message: issue ? `${issue.path.join(".")}: ${issue.message}` : undefined },
      { status: 400, headers: NO_STORE },
    );
  }

  const servers = parsed.data.servers;
  const names = new Set<string>();
  for (const server of servers) {
    const key = server.name.toLowerCase();
    if (names.has(key)) {
      return Response.json(
        { error: "duplicate_name", message: `Two servers are named "${server.name}"` },
        { status: 400, headers: NO_STORE },
      );
    }
    names.add(key);
  }

  try {
    writeMcpRegistry(dataDir(), servers);
  } catch (error) {
    return Response.json(
      {
        error: "write_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: NO_STORE },
    );
  }

  try {
    recordAudit(getBootDb(), {
      userId: String(decision.user.id),
      action: "mcp.registry.write",
      detail: { count: servers.length, names: servers.map((s) => s.name) },
      ip: clientIp(req),
    });
  } catch {
    /* best effort */
  }

  return Response.json({ ok: true, servers }, { headers: NO_STORE });
}
