import { requireActor } from "@/lib/auth/current-actor";
import { loadChatBootstrap } from "@/lib/chat/bootstrap";

/**
 * GET /api/bootstrap — everything the chat surface needs on first load:
 * workspace roots for the cwd picker, enabled providers with their declared
 * capabilities and model lists, and the default model.
 *
 * One call instead of three keeps the shell from waterfalling on mount.
 * Auth-gated and no-store: roots are host filesystem paths, and provider
 * inventory changes as soon as a session reports. Env is read server-side
 * only; the payload carries the derived roots, never the raw env.
 *
 * The composition lives in `loadChatBootstrap`, which the chat pages call
 * directly (a Server Component must not self-fetch). One implementation, so
 * a provider dropped for having no adapter is dropped here too — the API and
 * the page cannot disagree about what the composer may offer.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time; `requireActor` reads the session cookie, so this route is
 * request-time already.
 */

export async function GET(): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return Response.json({ error: decision.code }, { status: decision.status });
  }

  return Response.json(await loadChatBootstrap(), {
    headers: { "cache-control": "no-store" },
  });
}
