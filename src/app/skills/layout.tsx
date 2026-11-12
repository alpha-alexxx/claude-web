import { ChatShell } from "@/components/layout/chat-shell";

/**
 * Layout for /skills: the same app frame as chat, so the conversation list
 * stays put while you manage the shared skill store.
 *
 * A sibling of /chat/layout.tsx and /settings/layout.tsx rather than a shared
 * parent above all three: what they share is the frame component, and each
 * mount is its own instance. The frame prerenders; the sidebar's active-state
 * read of the pathname resolves inside its own `<Suspense>` (see ChatShell).
 */
export default function SkillsLayout({ children }: LayoutProps<"/skills">) {
  return <ChatShell>{children}</ChatShell>;
}
