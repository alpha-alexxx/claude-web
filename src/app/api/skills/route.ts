import { requireActor } from "@/lib/auth/current-actor";
import { ensureSkillsView } from "@/lib/skills/store";

/**
 * GET /api/skills — the Skills page's data.
 *
 * Admin-only: the list is a view of the host's `~/.agents/skills` tree, which
 * is operator state shared by every user of this server.
 *
 * The read also ENSURES the canonical store exists, because a missing store
 * and an empty store look identical in the UI but only one of them is fixed by
 * creating a directory. `ensureSkillsStore` never replaces a real
 * `~/.claude/skills` directory (it reports the conflict instead), so it is safe
 * to call on a GET. A store that cannot be created at all comes back as
 * `storeError` in the body rather than as a failed request: the page still has
 * tools and paths worth showing.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * `requireActor` reads the session cookie, which is request-time already.
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(): Promise<Response> {
  const decision = await requireActor("admin");
  if (!decision.ok) {
    return Response.json(
      { error: decision.code },
      { status: decision.status, headers: NO_STORE },
    );
  }

  return Response.json(ensureSkillsView(), { headers: NO_STORE });
}
