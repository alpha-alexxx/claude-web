import type { NextConfig } from "next";
import { parseAllowedDevOrigins } from "./src/lib/dev-origins";

/**
 * Dev-only: hostnames a tunnel may reach the dev server through.
 *
 * The dev server refuses `/_next` and `/__nextjs` (HMR, dev assets) when the
 * requesting page's hostname is not `localhost`, a subdomain of it, the
 * hostname it was started with, or one of these entries — it answers
 * `403 Unauthorized` and the page never hydrates. Cloudflare quick tunnels get
 * a random `*.trycloudflare.com` name, so that is pre-listed; a named tunnel on
 * your own domain goes in `ALLOWED_DEV_ORIGINS`. Next loads `.env` before
 * importing this file, which is why `process.env` is readable here.
 */
const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  allowedDevOrigins: parseAllowedDevOrigins(process.env.ALLOWED_DEV_ORIGINS),
  // The Agent SDK spawns a vendored CLI binary from its own package dir and
  // must not be bundled — keep it as a runtime require. (Under cacheComponents
  // route handlers may not export `runtime = "nodejs"`; node is the default.)
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  /**
   * Static security headers, on every path.
   *
   * Deliberately NOT the CSP: the CSP is built per request by Clerk's
   * `clerkMiddleware` (it knows the sign-in script, frame and telemetry hosts),
   * and a `headers()` entry for the same key would be assigned by the router
   * AFTER the Proxy ran, silently replacing it. HSTS is likewise not here — it
   * must only be sent on a request that actually arrived over TLS, which static
   * config cannot know behind a reverse proxy.
   *
   * These four are unconditional and additive, so static is the right place:
   * they cover route handlers, pages and `public/` alike.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            // No feature this app needs is in this list; every one of them is
            // one a compromised dependency could otherwise reach for.
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
