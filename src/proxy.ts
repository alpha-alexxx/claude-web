import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
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
 *
 * This is also the ONE owner of the Content-Security-Policy. It is built by
 * Clerk's own builder rather than hand-written because Clerk knows the hosts its
 * sign-in script, captcha frame and telemetry need; a hand-written policy breaks
 * sign-in in ways that only show up at the login screen. `content-security-policy.md`
 * says nonce-based CSP is incompatible with PPR, and this app runs
 * `partialPrefetching`, so the non-strict form is the honest choice: `script-src`
 * keeps `'unsafe-inline'` and `https:`. The compensating control is that no
 * agent output is ever rendered as HTML — there is no markdown renderer and no
 * `dangerouslySetInnerHTML` anywhere in `src/components`.
 *
 * Deliberately NOT in `next.config.ts` `headers()`: route-resolved headers are
 * assigned AFTER this Proxy runs and would silently replace the CSP with a
 * static one that lacks the request-specific bits.
 */

const isApiRoute = createRouteMatcher(["/api(.*)"]);

/**
 * True when this request actually arrived over TLS. Behind a reverse proxy the
 * inner hop is plain http, so `X-Forwarded-Proto` is the only real signal —
 * and it is only read when `TRUST_PROXY` is set, because an untrusted client can
 * set that header to anything, and a false HSTS makes the site unreachable over
 * http for a year.
 */
function isSecureRequest(req: NextRequest): boolean {
  if (req.nextUrl.protocol === "https:") return true;
  // `getEnv()` is deliberately not imported here: the Proxy runs before the app
  // and must not take a hard dependency on a schema that fails fast. This reads
  // the same two spellings the env schema accepts.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy === "true" || trustProxy === "1") {
    return req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  }
  return false;
}

function withHsts(req: NextRequest, res: NextResponse): NextResponse {
  if (isSecureRequest(req)) {
    // 2 years, subdomains, preload-eligible. Only ever sent over https.
    res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }
  return res;
}

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
      return withHsts(
        req,
        NextResponse.json(
          { error: { code: "unauthenticated", message: "Sign in required" } },
          { status: 401 },
        ),
      );
    }

    // Always return an explicit response so HSTS can be attached: Clerk applies
    // the CSP to whatever this handler returns, and an implicit `undefined`
    // would leave us no response of our own to decorate.
    return withHsts(req, NextResponse.next());
  },
  // Point `protect()` / `redirectToSignIn()` at our own pages instead of the
  // Clerk Account Portal. Configuring it here (not only via ClerkProvider)
  // matters because the Proxy runs server-side, where NEXT_PUBLIC_* props are
  // not available to ClerkProvider.
  {
    signInUrl: SIGN_IN_URL,
    signUpUrl: SIGN_UP_URL,
    contentSecurityPolicy: {
      directives: {
        // Nothing in this app embeds a plugin, a frame or a base tag; each of
        // these turns a hypothetical HTML-injection into a dead end.
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        // Clerk's default is `self` + img.clerk.com. Rendered images arrive
        // through /api/render as same-origin URLs, so `self` covers them; the
        // two extra sources are for avatars and inline data/blob previews.
        "img-src": ["'self'", "https://img.clerk.com", "data:", "blob:"],
      },
    },
  },
);

export const config = {
  matcher: [
    // Skip Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
