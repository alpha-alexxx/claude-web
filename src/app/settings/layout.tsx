import { ChatShell } from "@/components/layout/chat-shell";

/**
 * Layout for /settings/*: the same app frame as chat, so the conversation
 * sidebar and the account menu stay put while you are configuring things.
 *
 * It is a sibling of /chat/layout.tsx rather than a shared layout above both
 * because the two surfaces are different routes with different page chrome —
 * what they share is the frame component itself, not a parent layout. Each
 * mount of <ChatShell> is its own instance, which is correct here: switching
 * from chat to settings is a full navigation, not a remount mid-stream.
 *
 * Static: the frame itself prerenders; the sidebar's pathname-dependent active
 * state resolves inside its own `<Suspense>` boundary (see ChatShell).
 */
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return <ChatShell>{children}</ChatShell>;
}
