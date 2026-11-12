import { ChatShell } from "@/components/layout/chat-shell";

/**
 * Layout for /chat and /chat/[id]: the app frame (desktop sidebar + mobile
 * sheet) around whichever conversation surface the route renders.
 *
 * A layout rather than per-page markup: /chat and /chat/[id] must share ONE
 * sidebar instance, or navigating between them would remount the list (and
 * lose its scroll and open menu states).
 *
 * Not static, and it does not claim to be: the sidebar marks the active
 * conversation with `usePathname()`, and under `cacheComponents` a client hook
 * that reads the URL cannot sit in a prerendered shell. That is why ChatShell
 * wraps each sidebar instance in its own `<Suspense>` — the frame itself
 * prerenders, the pathname-dependent list resolves at request time.
 */
export default function ChatLayout({ children }: LayoutProps<"/chat">) {
  return <ChatShell>{children}</ChatShell>;
}
