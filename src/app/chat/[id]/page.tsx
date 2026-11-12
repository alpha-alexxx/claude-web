import "server-only";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { loadChatBootstrap } from "@/lib/chat/bootstrap";
import { loadConversation } from "@/lib/chat/conversation-load";
import { getBootDb } from "@/lib/db/boot";
import { ChatColumn } from "@/components/chat/chat-column";
import { SIGN_IN_URL } from "@/lib/auth/routes";

/**
 * /chat/[id] — a replayed conversation, resumed by sending from it.
 *
 * `[id]` is the CLIENT id (what the sidebar links to). Ownership follows the
 * API's rule, executed by the same shared loader: the row key derives from
 * the CALLER's user id, so another user's client id resolves nothing and gets
 * the same notFound a never-existed id gets — distinct responses would make
 * ids probeable.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. Instead the page is split — a static shell (prerendered, no
 * runtime reads) and `<ConversationSurface>` inside `<Suspense>`, which reads
 * the session cookie and the params at request time. Reading either outside
 * the boundary is a build error, not a hint.
 *
 * Params are awaited inside the boundary too: with no generateStaticParams,
 * the param is runtime data, and the shell (the desktop sidebar frame) must
 * not wait on it.
 */
export default function ConversationPage({
  params,
}: PageProps<"/chat/[id]">) {
  return (
    <Suspense fallback={<div className="flex-1" aria-hidden />}>
      <ConversationSurface params={params} />
    </Suspense>
  );
}

/** Request-time half: auth, then the row + transcript, then the column. */
async function ConversationSurface({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await currentActor();
  if (!actor) redirect(SIGN_IN_URL);
  const { id } = await params;

  const loaded = loadConversation(getBootDb(), String(actor.id), id);
  if (!loaded) notFound();

  const bootstrap = await loadChatBootstrap();
  return bootstrap.providers.length === 0 ? (
    <div className="flex flex-1 items-center justify-center p-8">
      <p className="max-w-md text-center text-muted-foreground">
        No provider is available (ENABLED_PROVIDERS has no working adapter).
        Set <code className="font-mono">ENABLED_PROVIDERS=claude</code> and
        restart the server.
      </p>
    </div>
  ) : (
    <ChatColumn
      bootstrap={bootstrap}
      conversationId={loaded.summary.id}
      initialView={loaded.view}
      initialCwd={loaded.summary.cwd}
      initialModel={loaded.summary.model}
      initialProvider={loaded.summary.provider}
    />
  );
}
