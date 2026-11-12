import type { SkillsView } from "@/lib/skills/types";
import { asRecord, getJson, sendJson, type ApiFailure } from "./api";

/**
 * Browser transport for the Skills page.
 *
 * The page shows one row per skill and a badge per tool. Every mutation is
 * "link this skill into that tool" or "unlink it", and the server decides
 * whether that is possible — a conflict (a real directory in the way, a tool
 * that reads the store natively) comes back as a refusal with a reason, and
 * that reason is what the badge tooltip shows. Nothing here pre-judges it.
 */

export type SkillsResult = { ok: true; view: SkillsView } | ApiFailure;

export type SkillActionOutcome = { ok: true } | ApiFailure;

export async function getSkills(
  opts: { fetch?: typeof fetch } = {},
): Promise<SkillsResult> {
  const result = await getJson("/api/skills", opts.fetch);
  if (!result.ok) return result;

  const body = asRecord(result.body);
  if (!body || !Array.isArray(body.skills) || !Array.isArray(body.tools)) {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, view: body as unknown as SkillsView };
}

export async function setSkillSync(
  slug: string,
  tool: string,
  action: "sync" | "unsync",
  opts: { fetch?: typeof fetch } = {},
): Promise<SkillActionOutcome> {
  const result = await sendJson(
    `/api/skills/${encodeURIComponent(slug)}/sync`,
    "POST",
    { tool, action },
    opts.fetch,
  );
  if (!result.ok) return result;
  // A refusal is a 409 that the shared helper already turned into a failure;
  // reaching here means the link changed, so the caller should refetch.
  return { ok: true };
}
