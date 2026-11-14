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
 *
 * `req.nextUrl.protocol` is itself derived from that same header by Next, so it
 * is evidence only when no header was sent: then the scheme came from the
 * socket (local TLS), not from a claim.
 */
function isSecureRequest(req: NextRequest): boolean {
  const forwarded = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  // `getEnv()` is deliberately not imported here: the Proxy runs before the app
  // and must not take a hard dependency on a schema that fails fast. This reads
  // the same two spellings the env schema accepts.
  const trustProxy = process.env.TRUST_PROXY;
  const trustsProxy = trustProxy === "true" || trustProxy === "1";
  if (!forwarded) return req.nextUrl.protocol === "https:";
  return trustsProxy && forwarded === "https";
}

function withHsts(req: NextRequest, res: NextResponse): NextResponse {
  if (isSecureRequest(req)) {
    // 2 years, subdomains, preload-eligible. Only ever sent over https.
    res.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  }
  return res;
}

/**
 * This machine, under any of the names a loopback connection can arrive on.
 *
 * Next derives the request origin from the server's bind address while Clerk
 * derives its rewrite from the URL the request arrived with, so the two
 * routinely disagree about which spelling names the same process. Both compare
 * as "us" here; every other host still has to match exactly.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * Turn "rewrite back to the URL we are already on" into "carry on".
 *
 * Clerk's `decorateRequest` (dist/cjs/server/utils.js) deletes the
 * `x-middleware-next` marker and replaces it with an ABSOLUTE
 * `x-middleware-rewrite` pointing at the request URL. Every layer below reads
 * that as a routing instruction rather than as a no-op:
 *
 * - `resolve-routes.js` relativizes the value against an origin derived from the
 *   `-H` bind address and only accepts it when the origins are IDENTICAL
 *   (`relativize-url.js`). They routinely are not — Next has already normalized
 *   the rewrite's host to `localhost` (`next-url.js`), while the derived origin
 *   is whatever the server was bound to. A mismatch leaves the value absolute,
 *   `parseUrl()` reports a protocol, and `router-server.js` proxies the server
 *   to itself. Through a TLS-terminating tunnel that is a TLS handshake against
 *   a plaintext port ("EPROTO wrong version number"); over plain http the
 *   request is simply rendered twice. Either way: 500.
 * - A RELATIVE value is not an escape hatch: `adapter.js` parses the header with
 *   `new NextURL(value, …)` and no base URL, so `/chat` throws
 *   `TypeError: Invalid URL (input: '/')` and every request 500s.
 *
 * The form both layers understand is the marker Clerk removed. `x-middleware-next`
 * skips the adapter's rewrite block outright, and `resolve-routes.js` consumes
 * and deletes it, leaving the request URL untouched — which is exactly what a
 * rewrite to the request's own URL asks for.
 *
 * Only an exact self-rewrite is converted. A rewrite to a different path is a
 * real rewrite (Clerk's `notFound()` emits `/clerk_<timestamp>`, and calling
 * that a no-op would render the protected page), and so is one to a different
 * host or port.
 */
export function resumeSelfRewrite(req: NextRequest, res: Response): Response {
  const value = res.headers.get("x-middleware-rewrite");
  // No rewrite at all: the router already carries on, and an already-relative
  // value is not something we produce (but is harmless left alone).
  if (!value || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return res;

  let target: URL;
  try {
    target = new URL(value, req.nextUrl);
  } catch {
    return res;
  }
  const self = req.nextUrl;
  const sameHost =
    target.hostname.toLowerCase() === self.hostname.toLowerCase() ||
    (isLoopback(target) && isLoopback(self));
  if (!sameHost || target.port !== self.port) return res;
  if (
    target.pathname !== self.pathname ||
    target.search !== self.search ||
    target.hash !== self.hash
  ) {
    return res;
  }

  const headers = new Headers(res.headers);
  headers.delete("x-middleware-rewrite");
  headers.set("x-middleware-next", "1");
  try {
    res.headers.delete("x-middleware-rewrite");
    res.headers.set("x-middleware-next", "1");
    return res;
  } catch {
    // Immutable headers: rebuild around a copy. It carries every Set-Cookie
    // Clerk just issued — dropping one is a sign-out loop.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}

const clerkProxy = clerkMiddleware(
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

/**
 * Clerk's middleware is wrapped rather than exported directly: `decorateRequest`
 * always writes an absolute `x-middleware-rewrite` back to the request URL, and
 * under a tunnel that absolute rewrite is what the router misreads as external.
 * See `resumeSelfRewrite`.
 */
export default async function proxy(
  req: NextRequest,
  event: Parameters<typeof clerkProxy>[1],
): Promise<Response> {
  return resumeSelfRewrite(req, await clerkProxy(req, event));
}

export const config = {
  matcher: [
    // Skip Next internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
