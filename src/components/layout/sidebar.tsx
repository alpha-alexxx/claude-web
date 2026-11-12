"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONVERSATIONS_CHANGED } from "@/lib/client/conversation-events";
import {
  conversationListStore,
  type ConversationListStore,
} from "@/lib/client/conversation-list-store";
import { useMounted } from "@/lib/client/use-mounted";
import { groupByRecency } from "@/lib/chat/conversation-groups";
import type { ConversationSummary } from "@/lib/chat/conversation-view";
import { cn } from "@/lib/utils";

/**
 * Sidebar: the conversation list, which is the app's real navigation.
 *
 * It is a client component for two reasons that are not negotiable:
 *   1. Rename/delete must not reload the page mid-turn. A server-rendered
 *      list would make every sidebar action a navigation, and the chat
 *      column's stream would be torn down underneath it.
 *   2. Recency buckets are LOCAL-calendar ("Today" is the viewer's today),
 *      which only the browser can decide.
 *
 * The list is per-user data fetched with `cache: "no-store"`. It is FEATURED
 * over the chat column, never beside it at narrow widths: the column needs
 * the width more than the index does.
 *
 * The rows themselves come from `conversationListStore`, not from local
 * state: `ChatShell` renders this component twice (desktop column + mobile
 * sheet), and two private copies would drift apart the moment either one was
 * renamed, deleted, or refreshed. This component owns only what is genuinely
 * per-instance — the open rename field on a row and the delete confirmation.
 *
 * Delete is a Dialog, not a confirm(); rename is inline in the row, because
 * renaming is a small, reversible thing and should cost one click, while
 * deleting a transcript should cost a deliberate one.
 */

export interface SidebarProps {
  /** Rendered beside the conversation list (user menu, theme toggle). */
  footer?: ReactNode;
  /** Close handler for the mobile sheet; absent on desktop. */
  onNavigate?: () => void;
  className?: string;
  /**
   * The shared list. Defaults to the app singleton; a test supplies its own.
   */
  store?: ConversationListStore;
}

type Row = ConversationSummary;

export function Sidebar({
  footer,
  onNavigate,
  className,
  store = conversationListStore,
}: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();

  // One list for the desktop column AND the mobile sheet: both subscribe to
  // the same store, so whichever copy is on screen shows the same rows and a
  // rename in one is already applied in the other.
  const { rows, loadFailed } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  // The active row is read from the URL, so it stays correct after the
  // first message's replaceState and after browser back/forward.
  const activeId = useMemo(() => {
    const match = /^\/chat\/([^/]+)$/.exec(pathname ?? "");
    return match ? decodeURIComponent(match[1]) : null;
  }, [pathname]);

  // Initial load and every navigation. The fetch is an async continuation —
  // not a synchronous setState in the effect body, which would cascade an
  // extra render before the request even left the browser. `refresh`
  // deduplicates, so both mounted copies asking at once cost one request.
  useEffect(() => {
    void store.refresh();
  }, [store, pathname]);

  // A turn writes rows server-side without telling us; refresh when the tab
  // regains focus, which is when the user would expect the list to be right.
  useEffect(() => {
    const onFocus = () => void store.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [store]);

  // The chat column announces each finished turn (the row was written
  // server-side); one refetch per announcement keeps the list truthful
  // without polling.
  useEffect(() => {
    const onChanged = () => void store.refresh();
    window.addEventListener(CONVERSATIONS_CHANGED, onChanged);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED, onChanged);
  }, [store]);

  const onRename = useCallback(
    async (id: string, title: string) => {
      const result = await store.rename(id, title);
      if (!result.ok) {
        toast.error(
          result.code === "not_found"
            ? "That conversation no longer exists."
            : "Could not rename the conversation.",
        );
      }
    },
    [store],
  );

  const onDelete = useCallback(
    async (id: string) => {
      const result = await store.remove(id);
      if (!result.ok) {
        toast.error("Could not delete the conversation.");
        return;
      }
      // Deleting the conversation you are looking at must move you off it;
      // staying would leave a composer posting to a row that no longer exists.
      if (id === activeId) {
        onNavigate?.();
        router.push("/chat");
      }
    },
    [activeId, onNavigate, router, store],
  );

  // Recency buckets need the viewer's clock, which must not be read during
  // the static prerender: `new Date()` in a prerendered Client Component is a
  // build error under cacheComponents (`blocking-prerender-current-time`).
  // `mounted` is false on the server and on the hydration pass, so the
  // prerender never evaluates the Date — and since the rows are fetched in an
  // effect anyway, the list is empty at that moment regardless.
  const mounted = useMounted();
  const groups = useMemo(
    () => (mounted ? groupByRecency(rows ?? [], new Date()) : []),
    [mounted, rows],
  );

  return (
    <nav
      aria-label="Conversations"
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="font-heading text-base tracking-tight">claude-web</span>
        <Button asChild size="sm" variant="ghost" className="ml-auto">
          <Link href="/chat" onClick={onNavigate}>
            <PlusIcon className="size-4" />
            <span className="sr-only sm:not-sr-only">New</span>
          </Link>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows === null ? (
          <SidebarSkeleton />
        ) : rows.length === 0 ? (
          <p className="px-2 py-6 text-xs leading-relaxed text-muted-foreground">
            {loadFailed
              ? "Could not load your conversations. Your history is safe — try reloading."
              : "No conversations yet. Send a message to start one."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="mb-3">
              <h2 className="px-2 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.label}
              </h2>
              <ul>
                {group.items.map((row) => (
                  <ConversationRow
                    key={row.id}
                    row={row}
                    active={row.id === activeId}
                    onNavigate={onNavigate}
                    onRename={onRename}
                    onDelete={onDelete}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {footer && (
        <div className="border-t border-sidebar-border px-3 py-2">{footer}</div>
      )}
    </nav>
  );
}

function ConversationRow({
  row,
  active,
  onNavigate,
  onRename,
  onDelete,
}: {
  row: Row;
  active: boolean;
  onNavigate?: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const title = row.title?.trim() || "Untitled conversation";

  if (renaming) {
    return (
      <li className="px-1 py-0.5">
        <RenameField
          initial={title}
          onSubmit={(next) => {
            setRenaming(false);
            if (next !== title) void onRename(row.id, next);
          }}
          onCancel={() => setRenaming(false)}
        />
      </li>
    );
  }

  return (
    <li className="group/row relative">
      <Link
        href={`/chat/${encodeURIComponent(row.id)}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "block truncate rounded-md py-1.5 pr-8 pl-2 text-sm outline-none",
          "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground",
        )}
        title={title}
      >
        {title}
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${title}`}
            className={cn(
              "absolute top-1 right-1 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
              active && "opacity-60",
            )}
          >
            <MoreIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              “{title}” and its transcript will be removed. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingDelete(false);
                void onDelete(row.id);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Inline rename: Enter commits, Escape cancels, blur commits like Enter. */
function RenameField({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Input
      autoFocus
      value={value}
      aria-label="Conversation title"
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value.trim() || initial);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value.trim() || initial)}
    />
  );
}

/**
 * The pre-stream stand-in for `Sidebar`.
 *
 * `Sidebar` reads `usePathname()`, which under `cacheComponents` is URL data
 * that only exists at runtime: on a route with an unknown dynamic param
 * (`/chat/[id]` has no `generateStaticParams`) that read suspends, and a
 * suspended read outside a boundary is a build error. `ChatShell` therefore
 * wraps every `<Sidebar>` in `<Suspense fallback={<SidebarFallback />}>`, and
 * this is the fallback — the same frame and skeleton the real list shows while
 * its first fetch is in flight, so the shell's static HTML and the streamed
 * replacement have the same shape.
 */
export function SidebarFallback() {
  return (
    <nav
      aria-label="Conversations"
      aria-busy="true"
      className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="font-heading text-base tracking-tight">claude-web</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SidebarSkeleton />
      </div>
    </nav>
  );
}

function SidebarSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 px-2 pt-3">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-7 animate-pulse rounded-md bg-sidebar-accent/60"
          style={{ width: `${90 - i * 11}%` }}
        />
      ))}
    </div>
  );
}

/* Inline icons (24px stroke style) — no icon package in the client bundle. */
function PlusIcon({ className }: { className?: string }) {
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}
