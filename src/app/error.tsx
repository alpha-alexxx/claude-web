"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The app-wide error boundary (Phase 8).
 *
 * `retry()` — not `reset()` — is the primary recovery action: the common
 * failure here is a request-time read (a DB query, the session check) that
 * failed once, and only a re-fetch can fix that. `reset()` would re-render the
 * same already-failed children.
 *
 * The message is shown only if there is one worth showing. Server Component
 * errors arrive with a generic message and a `digest` in production; the digest
 * is the only thing that ties this screen to a server log line, so it is shown
 * verbatim rather than hidden in the console.
 */
export default function ErrorBoundary({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const message =
    error instanceof Error && error.message && !/an error occurred in the server components/i.test(error.message)
      ? error.message
      : null;
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest)
      : null;

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl">Something went wrong</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            {message ??
              "This part of the app failed to load. Retrying re-runs the request that failed."}
          </p>
          {digest ? (
            <p className="font-mono text-xs text-muted-foreground/80">digest {digest}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => retry()}>Try again</Button>
          <Button variant="outline" asChild>
            <Link href="/chat">Back to chat</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
