import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { ensureSkillsView } from "@/lib/skills/store";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import { SkillsPanel } from "@/components/skills/skills-panel";

/**
 * /skills — the shared SKILL.md store and its per-tool links.
 *
 * Split like every other page under `cacheComponents`: a prerendered frame and
 * a request-time <SkillsSurface> inside <Suspense>, because the surface reads
 * the session cookie. Reading it outside the boundary is a build error.
 *
 * The read model comes from `ensureSkillsView` — the same function /api/skills
 * serves — so the page and the API cannot disagree about a badge. It runs
 * `ensureSkillsStore` for the same reason the GET does: a missing store and an
 * empty one render identically, and only one is fixed by creating a directory.
 * A store that cannot be created is reported in the view, not thrown: a
 * read-only home directory must not turn the Skills page into an error page.
 *
 * Non-admins are redirected rather than 403'd: the store is host operator
 * state, and a navigation that lands you back in chat beats a dead-end page.
 */
export default function SkillsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<SkillsSkeleton />}>
        <SkillsSurface />
      </Suspense>
    </div>
  );
}

async function SkillsSurface() {
  // Proxy does the cheap redirect; the page still verifies — matcher changes
  // can silently drop Proxy coverage (see current-actor.ts).
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  if (actor.role !== "admin") redirect("/chat");

  return <SkillsPanel initialView={ensureSkillsView()} />;
}

function SkillsSkeleton() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="mb-6 h-6 w-40 animate-pulse rounded-md bg-muted" />
      <div className="mb-4 h-20 animate-pulse rounded-xl bg-muted/60" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
