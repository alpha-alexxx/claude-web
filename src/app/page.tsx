import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-heading text-4xl">claude-web</h1>
      <p className="max-w-md text-center text-muted-foreground">
        A browser wrapper around coding-agent CLIs. Chat, tool calls, skills,
        plugins and settings — no terminal needed.
      </p>
      <div className="flex items-center gap-3">
        <Button asChild>
          <Link href="/login">Sign in</Link>
        </Button>
        <ThemeToggle />
      </div>
    </main>
  );
}
