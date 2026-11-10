import Link from "next/link";
import { Suspense } from "react";
import { Show, UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { SIGN_IN_URL } from "@/lib/auth/routes";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-heading text-4xl">claude-web</h1>
      <p className="max-w-md text-center text-muted-foreground">
        A browser wrapper around coding-agent CLIs. Chat, tool calls, skills,
        plugins and settings — no terminal needed.
      </p>
      <div className="flex items-center gap-3">
        {/* <Show> reads the request in a Server Component, and the project runs
            with `cacheComponents: true`, so it must sit under <Suspense>. */}
        <Suspense fallback={<div className="h-9 w-32" aria-hidden />}>
          <Show when="signed-out">
            <Button asChild>
              <Link href={SIGN_IN_URL}>Sign in</Link>
            </Button>
          </Show>
          <Show when="signed-in">
            <Button asChild>
              <Link href="/chat">Open chat</Link>
            </Button>
            <UserButton />
          </Show>
        </Suspense>
        <ThemeToggle />
      </div>
    </main>
  );
}
