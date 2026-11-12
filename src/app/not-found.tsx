import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The app-wide 404 (Phase 8).
 *
 * A Server Component with no request reads, so it stays prerendered. It
 * deliberately does not say *which* id was missing: conversation ids are
 * unguessable, but "this id does not exist" and "this id belongs to someone
 * else" must still be indistinguishable, and the same page answers both.
 */
export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-xs text-muted-foreground">404</p>
          <h1 className="font-heading text-2xl">Not found</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            This page doesn&apos;t exist, or the conversation it pointed at has
            been deleted.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link href="/chat">Back to chat</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
