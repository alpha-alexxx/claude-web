import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { getEnv } from "@/lib/env";
import { runArgv } from "@/lib/exec/run";

/**
 * POST /api/plugins/[id] — enable or disable one Claude plugin.
 *
 * The plugin id comes from `claude plugin list --json` and is passed as ONE
 * argv entry to `claude plugin enable|disable <id>`: there is no shell, so a
 * hostile id is a bad argument, not syntax. The id is still validated to a
 * conservative shape (`name@marketplace`) because a value starting with `-`
 * would be read as a flag.
 *
 * Rate-limited with the install bucket: this spawns a process, and a loop of
 * enable/disable is the same abuse as a loop of installs.
 *
 * Only Claude is supported. The other providers have no machine-readable
 * inventory in this build, so there is nothing to toggle.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
 */

const ParamsSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    // `name` or `name@marketplace`; first character alphanumeric so a leading
    // `-` can never reach the CLI as a flag.
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/),
});

const BodySchema = z.object({ enabled: z.boolean() });

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

  const { id: rawId } = await ctx.params;
  const id = ParamsSchema.safeParse({ id: rawId });
  if (!id.success) {
    return Response.json({ error: "invalid_plugin_id" }, { status: 400, headers: NO_STORE });
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

  const pluginId = id.data.id;
  const verb = parsed.data.enabled ? "enable" : "disable";
  // Same override the listing uses, read through getEnv() so both routes agree
  // about the binary and a test can exercise the override without touching
  // process.env directly.
  const bin = getEnv().CLAUDE_EXECUTABLE?.trim() || "claude";

  const result = await runArgv(bin, ["plugin", verb, pluginId], { timeoutMs: 60_000 });

  try {
    recordAudit(getBootDb(), {
      userId: String(decision.user.id),
      action: `plugin.${verb}.${result.code === 0 ? "ok" : "failed"}`,
      detail: { plugin: pluginId, code: result.code, error: result.error },
      ip: clientIp(req),
    });
  } catch {
    /* best effort */
  }

  if (result.error) {
    return Response.json(
      { ok: false, code: "cli_missing", message: `Could not run the Claude CLI: ${result.error}` },
      { status: 502, headers: NO_STORE },
    );
  }
  if (result.code !== 0) {
    const message =
      result.stderr.split("\n").find((line) => line.trim() !== "")?.trim() ??
      `claude plugin ${verb} exited with code ${result.code}`;
    return Response.json(
      { ok: false, code: "cli_failed", message },
      { status: 502, headers: NO_STORE },
    );
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
