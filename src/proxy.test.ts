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

const { config } = await import("./proxy");

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
});
