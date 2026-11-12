import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/auth/current-actor";
import { loadChatBootstrap } from "@/lib/chat/bootstrap";
import { ChatColumn } from "@/components/chat/chat-column";
import { SIGN_IN_URL } from "@/lib/auth/routes";

/**
 * /chat — a new conversation.
 *
 * The page is a Server Component: it assembles the bootstrap payload by
 * calling the same server modules /api/bootstrap composes (no self-fetch —
 * an internal hop would need a cookie pass-through and add latency for
 * nothing), then hands it to the client ChatColumn.
 *
 * Auth: /chat is a PROTECTED_ROOT, so the Proxy redirects signed-out users
 * to sign-in before this renders. (API routes authenticate themselves;
 * pages rely on the Proxy for the redirect only.)
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. Instead the layout is split in two — a static shell (the page
 * frame, prerendered) and `<ChatSurface>` inside `<Suspense>`, which reads the
 * session cookie and streams at request time. Reading the cookie outside a
 * boundary is a build error, not a hint: the whole route would lose its
 * prerendered shell.
 *
 * The conversation id is minted client-side by ChatColumn (crypto.randomUUID
 * in a lazy initializer): no server round trip before the composer is ready,
 * and the URL settles to /chat/<id> on the first send — the row only exists
 * once the chat route creates it.
 */
export default function ChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={<ChatSurfaceSkeleton />}>
        <ChatSurface />
      </Suspense>
    </div>
  );
}

/** Request-time half: auth, then the bootstrap payload. */
async function ChatSurface() {
  // Proxy does the cheap redirect; each server component still verifies —
  // matcher changes can silently drop Proxy coverage (ledgered Phase 2c).
  if (!(await currentActor())) redirect(SIGN_IN_URL);
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
    <ChatColumn bootstrap={bootstrap} />
  );
}

/**
 * Prerendered while the session is verified. Deliberately bare: a spinner
 * would flash for one round trip and read as a second, slower load.
 */
function ChatSurfaceSkeleton() {
  return <div className="flex-1" aria-hidden />;
}
