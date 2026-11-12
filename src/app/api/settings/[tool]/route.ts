import { homedir } from "node:os";
import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge, BODY_CAPS } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import {
  SETTINGS_TARGETS,
  applySettingsWrite,
  readSettingsFile,
  type SettingsTool,
  type ToolSettingsTarget,
} from "@/lib/settings/files";
import { settingsPayloadSchema } from "@/lib/settings/redact";

/**
 * GET /api/settings/[tool] — one tool's settings, redacted.
 * PUT /api/settings/[tool] — validate, back up, atomically write.
 *
 * The tool name decides the destination path; the client never sends one. The
 * GET deliberately does not echo a file it cannot parse (see files.ts) — the
 * editor gets an empty document and the parse error, because a file that
 * failed to parse may contain a secret the redacting parse would have removed.
 *
 * A PUT that changes nothing is a no-op: the operator's formatting and TOML
 * comments survive an open-and-save.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
 */

const ParamsSchema = z.object({
  tool: z.enum(["claude", "codex", "opencode", "qoder"]),
});

const NO_STORE = { "cache-control": "no-store" } as const;

function targetFor(tool: SettingsTool): ToolSettingsTarget {
  return SETTINGS_TARGETS[tool];
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ tool: string }> },
): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }

  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) {
    return Response.json({ error: "unknown_tool" }, { status: 404, headers: NO_STORE });
  }

  // `readSettingsFile` redacts both the value and the text; nothing else may
  // touch the raw bytes on the way out.
  return Response.json(
    readSettingsFile(homedir(), targetFor(params.data.tool)),
    { headers: NO_STORE },
  );
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ tool: string }> },
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
    { bucket: "settings", id: String(decision.user.id) },
    { max: 30, windowMs: 60_000 },
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const params = ParamsSchema.safeParse(await ctx.params);
  if (!params.success) {
    return Response.json({ error: "unknown_tool" }, { status: 404, headers: NO_STORE });
  }

  // A settings file legitimately runs to 512 KB (the schema's own ceiling), so
  // this is the general cap — and the schema still bounds the parsed text.
  if (bodyTooLarge(req, BODY_CAPS.general)) {
    return Response.json({ error: "body_too_large" }, { status: 413, headers: NO_STORE });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  const body = settingsPayloadSchema.safeParse(raw);
  if (!body.success) {
    return Response.json(
      { error: "invalid_body", message: body.error.issues[0]?.message },
      { status: 400, headers: NO_STORE },
    );
  }

  const tool = params.data.tool;
  const result = applySettingsWrite(homedir(), targetFor(tool), body.data.text);

  try {
    recordAudit(getBootDb(), {
      userId: String(decision.user.id),
      action: `settings.write.${tool}.${result.ok ? "ok" : result.code}`,
      // Never the contents — the file can hold secrets by definition.
      detail: { tool, backup: result.ok ? result.backup !== null : false },
      ip: clientIp(req),
    });
  } catch {
    /* best effort */
  }

  if (!result.ok) {
    // Parse failures are the editor's problem (400); a failed write is the
    // filesystem's — a permissions or disk error the operator cannot fix by
    // editing the text — so it is a 500, matching what actually happened.
    return Response.json(
      { ok: false, code: result.code, message: result.message },
      { status: result.code === "write_failed" ? 500 : 400, headers: NO_STORE },
    );
  }
  return Response.json(
    { ok: true, path: result.path, backup: result.backup },
    { headers: NO_STORE },
  );
}
