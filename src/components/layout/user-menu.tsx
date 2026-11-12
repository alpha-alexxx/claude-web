"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

/**
 * The signed-in identity strip at the bottom of the sidebar.
 *
 * Clerk's UserButton is the account surface (profile, sign out); settings and
 * theme sit beside it because all three are "app chrome", not conversation
 * navigation. Kept out of <Sidebar> itself so the list component stays
 * testable and reusable without Clerk in its tree.
 *
 * The settings link is unconditional even though most sections are
 * admin-only: the destination decides what the signed-in person may see, and
 * hiding the entry point would make the page unreachable for the one person
 * who is allowed to use it (the sidebar has no idea who is signed in).
 */
export function UserMenu() {
  return (
    <div className="flex items-center gap-2">
      <UserButton
        appearance={{ elements: { avatarBox: "size-7", userButtonBox: "size-7" } }}
      />
      <Button asChild variant="ghost" size="icon-sm" className="ml-auto">
        <Link href="/settings" aria-label="Settings">
          <GearIcon className="size-4" />
        </Link>
      </Button>
      <ThemeToggle />
    </div>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}
