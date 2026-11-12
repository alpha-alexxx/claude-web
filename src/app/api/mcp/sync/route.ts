import { z } from "zod";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { getEnv } from "@/lib/env";
import { syncMcpToTool, type SyncMcpResult } from "@/lib/mcp/store";

/**
 * POST /api/mcp/sync — push the registry into one tool's native config.
 *
 * The request names a TOOL, never a path: the destination is decided here, so
 * a client cannot aim a write at an arbitrary file. A refusal (a config file
 * that does not parse) is a 409 carrying the path and the reason — the page
 * tells the operator which file to fix by hand.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
 */

const BodySchema = z.object({
  tool: z.enum(["claude", "codex", "opencode", "qoder"]),
});

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
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
    { bucket: "mcp-sync", id: String(decision.user.id) },
    { max: 20, windowMs: 60_000 },
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
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

  const tool = parsed.data.tool;
  const result: SyncMcpResult = syncMcpToTool(
    homedir(),
    dirname(getEnv().DATABASE_PATH),
    tool,
  );

  try {
    recordAudit(getBootDb(), {
      userId: String(decision.user.id),
      action: `mcp.sync.${tool}.${result.ok ? "ok" : "failed"}`,
      detail: result.ok ? { path: result.path, count: result.count } : { reason: result.reason },
      ip: clientIp(req),
    });
  } catch {
    /* best effort */
  }

  if (!result.ok) {
    return Response.json(
      { ok: false, code: "refused", message: result.reason },
      { status: 409, headers: NO_STORE },
    );
  }
  return Response.json(
    { ok: true, path: result.path, count: result.count },
    { headers: NO_STORE },
  );
}
