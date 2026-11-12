"use client";

import { Suspense, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Sidebar, SidebarFallback } from "./sidebar";
import { UserMenu } from "./user-menu";

/**
 * ChatShell: the app frame around every chat surface.
 *
 * Desktop keeps the conversation list permanently beside the column. Narrow
 * screens put it behind a Sheet instead of squeezing both — at phone width
 * the list would steal the width the transcript needs, and a transcript is
 * the thing you came for.
 *
 * The shell is a Client Component only for the sheet's open state; the
 * children it frames are server-rendered pages passed straight through, so
 * nothing about a page's data flow changes by living here.
 *
 * Each `<Sidebar>` sits inside its own `<Suspense>`: the sidebar derives the
 * active row from `usePathname()`, and under `cacheComponents` that is runtime
 * URL data — on `/chat/[id]`, whose param has no `generateStaticParams`, the
 * read suspends and would otherwise fail the prerender of the layout's shell.
 * The boundary is per-instance, not per-route, so both `/chat` and `/chat/[id]`
 * still share this one sidebar across navigations: on the client the pathname
 * is already known, so the boundary resolves without another fallback pass.
 */
export function ChatShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border md:block">
        <Suspense fallback={<SidebarFallback />}>
          <Sidebar footer={<UserMenu />} />
        </Suspense>
      </aside>

      {/* One <Sheet> wraps the content column so the trigger can live in the
          mobile bar while the panel portals to the body. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 border-b border-border px-2 py-1.5 md:hidden">
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open conversations"
              >
                <MenuIcon className="size-4" />
              </Button>
            </SheetTrigger>
            <span className="font-heading text-sm">claude-web</span>
          </div>
          {children}
        </div>

        <SheetContent
          side="left"
          showCloseButton={false}
          aria-describedby={undefined}
          className="w-72 gap-0 border-sidebar-border bg-sidebar p-0"
        >
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <Suspense fallback={<SidebarFallback />}>
            <Sidebar onNavigate={() => setOpen(false)} footer={<UserMenu />} />
          </Suspense>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
