import { Suspense } from "react";
import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Create account — claude-web",
};

/**
 * Catch-all sign-up route. Sign-ups are expected to be disabled in the Clerk
 * Dashboard for a self-hosted instance; the page exists so that Clerk has a
 * local destination and so the first admin can be created through it if the
 * dashboard allows it.
 *
 * Wrapped in <Suspense> for `cacheComponents: true` (request data read
 * outside a Suspense boundary fails the build).
 */
export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <Suspense fallback={<SignUpSkeleton />}>
        <SignUp />
      </Suspense>
    </main>
  );
}

function SignUpSkeleton() {
  return (
    <div
      aria-hidden
      className="h-[520px] w-full max-w-sm animate-pulse rounded-xl border bg-card"
    />
  );
}
