import { homedir } from "node:os";
import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { clientIp } from "@/lib/auth/client-ip";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sameOrigin, bodyTooLarge } from "@/lib/auth/request-guards";
import { getBootDb } from "@/lib/db/boot";
import { recordAudit } from "@/lib/db/audit-repo";
import { skillSlug } from "@/lib/skills/frontmatter";
import {
  syncSkillToTool,
  unsyncSkillFromTool,
  type SkillTool,
  type SyncResult,
} from "@/lib/skills/store";

/**
 * POST /api/skills/[slug]/sync — link one skill into one tool, or remove it.
 *
 * The slug is validated by `skillSlug` before it reaches the store: it becomes
 * a directory name, so `../etc` or an absolute path must be refused here rather
 * than defended against deeper in. Unknown tools are refused by the enum.
 *
 * `sync` is idempotent (re-linking an already-linked skill succeeds);
 * `unsync` never deletes a real directory, and returns its reason when it
 * declines so the badge can say why.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * auth reads the session cookie, so this is request-time already.
 */

const BodySchema = z.object({
  tool: z.enum(["claude", "codex", "opencode", "qoder"]),
  action: z.enum(["sync", "unsync"]),
});

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
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

  // Linking touches the filesystem; keep a stuck client from hammering it.
  // Size is the general API bucket — this is not a process spawn.
  const limit = checkRateLimit(
    { bucket: "skills", id: String(decision.user.id) },
    { max: 30, windowMs: 60_000 },
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const { slug: rawSlug } = await ctx.params;
  const slug = skillSlug(rawSlug);
  if (slug === null) {
    return Response.json({ error: "invalid_slug" }, { status: 400, headers: NO_STORE });
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

  const { tool, action } = parsed.data as {
    tool: SkillTool;
    action: "sync" | "unsync";
  };
  const home = homedir();
  let result: SyncResult;
  try {
    result =
      action === "sync"
        ? syncSkillToTool(home, slug, tool)
        : unsyncSkillFromTool(home, slug, tool);
  } catch (err) {
    // The store returns reasons rather than throwing, but an errno we have
    // never seen (EIO on a flaky mount, ELOOP in a link cycle) must still land
    // as a refusal with an explanation, not as a 500 the page can only call
    // "that did not work".
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    try {
      recordAudit(getBootDb(), {
        userId: String(decision.user.id),
        action: `skill.${action}`,
        detail: { slug, tool },
        ip: clientIp(req),
      });
    } catch {
      // Audit is a record, not a gate — see audit-repo's contract.
    }
  }

  if (!result.ok) {
    return Response.json(
      { ok: false, code: "refused", message: result.reason },
      { status: 409, headers: NO_STORE },
    );
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
