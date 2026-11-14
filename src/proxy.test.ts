import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * src/proxy.ts makes three decisions that no other file can be observed
 * making: whether a page navigation is redirected to sign-in, whether an
 * unauthenticated API request gets a JSON 401, and whether HSTS is attached
 * (HTTPS only, and only when TRUST_PROXY vouches for the forwarded header).
 * It also owns the CSP options handed to Clerk.
 *
 * None of that is reachable through a route test, so `clerkMiddleware` is
 * replaced by a pass-through that hands back the handler and options this
 * module registered — the test then drives the real handler.
 */

type Handler = (auth: unknown, req: NextRequest) => Promise<Response>;
type Options = Record<string, unknown>;

const captured: { handler: Handler | null; options: Options | null } = {
  handler: null,
  options: null,
};

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: Handler, options: Options) => {
    captured.handler = handler;
    captured.options = options;
    return handler;
  },
  createRouteMatcher: (patterns: string[]) => {
    const regexes = patterns.map(
      (p) =>
        new RegExp(
          `^${p
            .replace(/[.]/g, "\\.")
            .replace(/\(\.\*\)/g, "(.*)")
            .replace(/\(.*?\)/g, "(.*)")}$`,
        ),
    );
    return (request: NextRequest) =>
      regexes.some((r) => r.test(request.nextUrl.pathname));
  },
}));

const { config, resumeSelfRewrite } = await import("./proxy");

/** A Clerk `auth` stand-in: callable, and carrying `protect`. */
function fakeAuth(userId: string | null) {
  const protect = vi.fn(() => Promise.resolve());
  const fn = (() => Promise.resolve({ userId })) as unknown as {
    (): Promise<{ userId: string | null }>;
    protect: () => Promise<void>;
  };
  fn.protect = protect;
  return fn;
}

function run(
  pathname: string,
  headers: Record<string, string> = {},
  userId: string | null = "user_1",
) {
  const request = new NextRequest(`http://localhost${pathname}`, { headers });
  const auth = fakeAuth(userId);
  const response = captured.handler!(auth, request) as Promise<Response>;
  return { auth, response };
}

describe("proxy", () => {
  beforeEach(() => {
    process.env.TRUST_PROXY = "false";
  });

  it("returns the handler and Clerk options at module load", () => {
    expect(typeof captured.handler).toBe("function");
    // Both must be re-returned explicitly; otherwise Clerk's builder falls
    // back to its Account Portal and `protect()` redirects off-site.
    expect(captured.options?.signInUrl).toBe("/sign-in");
    expect(captured.options?.signUpUrl).toBe("/sign-up");
  });

  it("hands Clerk a CSP with the app's own overrides on top of its defaults", () => {
    const csp = captured.options?.contentSecurityPolicy as {
      directives: Record<string, string[]>;
    };
    expect(csp.directives["object-src"]).toEqual(["'none'"]);
    expect(csp.directives["base-uri"]).toEqual(["'self'"]);
    expect(csp.directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp.directives["form-action"]).toEqual(["'self'"]);
    expect(csp.directives["img-src"]).toContain("data:");
    expect(csp.directives["img-src"]).toContain("blob:");
  });

  it("matches API routes and Clerk's own paths with the documented matcher", () => {
    expect(config.matcher).toContain("/(api|trpc)(.*)");
    expect(config.matcher).toContain("/__clerk/(.*)");
  });

  it("calls protect() for a protected page and leaves public pages alone", async () => {
    const protectedRun = run("/chat/abc", {}, null);
    await protectedRun.response;
    expect(protectedRun.auth.protect).toHaveBeenCalled();

    const publicRun = run("/sign-in", {}, null);
    await publicRun.response;
    expect(publicRun.auth.protect).not.toHaveBeenCalled();
  });

  it("answers an unauthenticated API request with a JSON 401, not a redirect", async () => {
    const res = await run("/api/chat", {}, null).response;
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "unauthenticated" },
    });
  });

  it("lets an authenticated API request through", async () => {
    const res = await run("/api/chat", {}, "user_1").response;
    expect(res.status).toBe(200);
  });

  it("does not attach HSTS to a plain-http request", async () => {
    process.env.TRUST_PROXY = "true";
    const res = await run("/api/chat", { "x-forwarded-proto": "http" }).response;
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("attaches HSTS when the forwarded protocol says https and TRUST_PROXY is on", async () => {
    process.env.TRUST_PROXY = "true";
    const res = await run("/api/chat", { "x-forwarded-proto": "https" })
      .response;
    const hsts = res.headers.get("strict-transport-security");
    expect(hsts).toContain("max-age=63072000");
    expect(hsts).toContain("preload");
  });

  it("IGNORES a forged X-Forwarded-Proto when TRUST_PROXY is off", async () => {
    // Otherwise any client could make the app assert HSTS for a year over a
    // plain-http deployment, which locks the origin until the policy expires.
    process.env.TRUST_PROXY = "false";
    const res = await run("/api/chat", { "x-forwarded-proto": "https" })
      .response;
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("reads only the first X-Forwarded-Proto value when several are present", async () => {
    process.env.TRUST_PROXY = "true";
    const res = await run("/api/chat", { "x-forwarded-proto": "https, http" })
      .response;
    expect(res.headers.get("strict-transport-security")).toBeTruthy();
  });

  it("does not let a forged X-Forwarded-Proto assert HSTS even when the derived request URL is https", async () => {
    // Next derives `req.nextUrl.protocol` from X-Forwarded-Proto, so with
    // TRUST_PROXY off an untrusted client can make the request look encrypted.
    // The header-derived verdict must therefore require TRUST_PROXY; only the
    // absence of the header leaves the URL itself as evidence.
    process.env.TRUST_PROXY = "false";
    const request = new NextRequest("https://localhost/api/chat", {
      headers: { "x-forwarded-proto": "https" },
    });
    const res = await (captured.handler!(fakeAuth("user_1"), request) as Promise<Response>);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("attaches HSTS to an https request that carries no forwarded header", async () => {
    // A dev server terminating TLS itself (or a test) has no proxy header, and
    // its URL scheme is trustworthy — nothing asked us to believe a claim.
    process.env.TRUST_PROXY = "false";
    const request = new NextRequest("https://localhost/api/chat");
    const res = await (captured.handler!(fakeAuth("user_1"), request) as Promise<Response>);
    expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
  });
});

/**
 * Clerk's `decorateRequest` always answers with an ABSOLUTE
 * `x-middleware-rewrite` pointing back at the request URL:
 *
 *   if (res.headers.get("x-middleware-next") === "1") {
 *     res.headers.delete("x-middleware-next");
 *     rewriteURL = new URL(req.url);
 *   }
 *   ...
 *   res.headers.set("x-middleware-rewrite", rewriteURL.href);
 *
 * (node_modules/@clerk/nextjs/dist/cjs/server/utils.js). Every layer below
 * treats that as a routing instruction rather than as "carry on":
 *
 * - `resolve-routes.js` relativizes it against the origin it derived from the
 *   `-H` bind value and only accepts it when the origins are IDENTICAL
 *   (`relativize-url.js`). When they differ it stays absolute, `parseUrl()`
 *   reports a protocol, and the router proxies the server to itself
 *   (`router-server.js` → `proxyRequest`). Behind a TLS-terminating tunnel that
 *   is a TLS handshake against a plaintext port — `EPROTO wrong version
 *   number`, and a 500 on every request.
 * - `adapter.js` cannot be handed a relative value either: it parses the header
 *   with `new NextURL(value, {...})` and NO base URL, so `/chat` throws
 *   `TypeError: Invalid URL (input: '/')` — every request 500s.
 *
 * The one form both sides understand is the header the rewrite replaced:
 * `x-middleware-next: 1`. It skips the adapter's rewrite block entirely and
 * tells the router to continue with the URL it already has — which is exactly
 * what a rewrite to the request's own URL means.
 */
describe("resumeSelfRewrite", () => {
  function withRewrite(value: string, headers: Record<string, string> = {}) {
    return new Response("ok", {
      headers: { "x-middleware-rewrite": value, ...headers },
    });
  }

  it("turns a rewrite to the request's own URL into `x-middleware-next`", () => {
    const req = new NextRequest("https://localhost:8765/chat?x=1");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://localhost:8765/chat?x=1"),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("treats a loopback alias (127.0.0.1 vs localhost) as this server", () => {
    // Clerk derives the rewrite from `req.url`, which Next has already
    // normalized to `localhost`, while the router derives its own origin from
    // the bind address. Both spellings name this process.
    const req = new NextRequest("http://127.0.0.1:8765/chat");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://localhost:8765/chat"),
    );
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("leaves a rewrite to a DIFFERENT path absolute", () => {
    // Clerk's notFound() path: `NextResponse.rewrite(new URL('/clerk_<ts>',
    // req.url))`. It must still rewrite — converting it to `next` would render
    // the protected page instead of the 404.
    const req = new NextRequest("https://localhost:8765/chat/abc");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://localhost:8765/clerk_1794593063808"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://localhost:8765/clerk_1794593063808",
    );
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });

  it("leaves a rewrite that only changes the query absolute", () => {
    const req = new NextRequest("https://localhost:8765/chat?x=1");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://localhost:8765/chat?x=2"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://localhost:8765/chat?x=2",
    );
  });

  it("leaves a loopback rewrite on a different port absolute", () => {
    // Same host, different port is a different server — proxying it is correct.
    const req = new NextRequest("https://localhost:8765/chat");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://localhost:3000/chat"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://localhost:3000/chat",
    );
  });

  it("leaves an external rewrite absolute", () => {
    const req = new NextRequest("https://localhost:8765/");
    const res = resumeSelfRewrite(
      req,
      withRewrite("https://example.com/elsewhere"),
    );
    expect(res.headers.get("x-middleware-rewrite")).toBe(
      "https://example.com/elsewhere",
    );
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });

  it("keeps a same-origin rewrite exact — path and query both compared", () => {
    // The public origin case: a real hostname, not loopback.
    const req = new NextRequest("https://app.example.com/chat?a=1");
    const same = resumeSelfRewrite(
      req,
      withRewrite("https://app.example.com/chat?a=1"),
    );
    expect(same.headers.get("x-middleware-next")).toBe("1");
    const different = resumeSelfRewrite(
      req,
      withRewrite("https://app.example.com/chat?a=1&b=2"),
    );
    expect(different.headers.get("x-middleware-rewrite")).toBe(
      "https://app.example.com/chat?a=1&b=2",
    );
  });

  it("returns a response without a rewrite untouched", () => {
    const req = new NextRequest("https://localhost:8765/");
    const res = resumeSelfRewrite(req, new Response("ok"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBeNull();
  });

  it("keeps every Set-Cookie, because losing one is a sign-out loop", () => {
    const req = new NextRequest("https://localhost:8765/chat");
    const original = withRewrite("https://localhost:8765/chat", {
      "set-cookie": "__session=abc; Path=/",
    });
    const res = resumeSelfRewrite(req, original);
    expect(res.headers.get("set-cookie")).toBe("__session=abc; Path=/");
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
