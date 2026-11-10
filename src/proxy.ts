import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isProtectedPage, SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes";

/**
 * Next 16 renamed middleware to Proxy (see node_modules/next/dist/docs/
 * 01-app/03-api-reference/03-file-conventions/proxy.md). Clerk's
 * `clerkMiddleware()` is the middleware implementation; this file is where it
 * is mounted.
 *
 * By default `clerkMiddleware()` protects NOTHING — it only parses the session
 * cookie and makes `auth()` available. Protection is explicit below, and the
 * API handlers protect themselves (Clerk's `protect()` returns 404 for
 * non-document requests, which is the wrong answer for a JSON API).
 */

const isApiRoute = createRouteMatcher(["/api(.*)"]);

export default clerkMiddleware(
  async (auth, req) => {
    const { pathname } = req.nextUrl;

    // Redirect page navigations to the local sign-in screen. Authenticated
    // pages still re-check the session themselves (cacheComponents requires the
    // gate to live under a Suspense boundary anyway).
    if (isProtectedPage(pathname)) {
      await auth.protect();
    }

    // API routes must answer with a JSON 401 from their own handlers, never with
    // Clerk's 404-for-API behaviour or an HTML redirect.
    if (isApiRoute(req) && (await auth()).userId === null) {
      return NextResponse.json(
        { error: { code: "unauthenticated", message: "Sign in required" } },
        { status: 401 },
      );
    }
  },
  // Point `protect()` / `redirectToSignIn()` at our own pages instead of the
  // Clerk Account Portal. Configuring it here (not only via ClerkProvider)
  // matters because the Proxy runs server-side, where NEXT_PUBLIC_* props are
  // not available to ClerkProvider.
  { signInUrl: SIGN_IN_URL, signUpUrl: SIGN_UP_URL },
);

export const config = {
  matcher: [
    // Skip Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
