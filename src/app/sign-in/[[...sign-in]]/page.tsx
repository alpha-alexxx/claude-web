import { Suspense } from "react";
import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Sign in — claude-web",
};

/**
 * Catch-all sign-in route, so Clerk can drive multi-step flows
 * (/sign-in/factor-one, /sign-in/sso-callback, …).
 *
 * `<SignIn />` reads the request, and the project runs with
 * `cacheComponents: true`, which makes reading request data outside
 * `<Suspense>` a build error — hence the fallback below.
 */
export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <Suspense fallback={<SignInSkeleton />}>
        <SignIn />
      </Suspense>
    </main>
  );
}

function SignInSkeleton() {
  return (
    <div
      aria-hidden
      className="h-[420px] w-full max-w-sm animate-pulse rounded-xl border bg-card"
    />
  );
}
