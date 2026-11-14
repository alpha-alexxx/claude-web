import { describe, expect, it } from "vitest";
import { parseAllowedDevOrigins } from "./dev-origins";

/**
 * `next.config.ts` cannot import the zod env schema (it is loaded by Next's
 * config loader, outside the app runtime), so the tunnel-hostname list is
 * parsed by this small module and reused there. The parsing rules matter
 * because a malformed entry silently fails to unblock the dev server, and the
 * failure shows up only as `403 Unauthorized` on a hashed asset URL.
 */
describe("parseAllowedDevOrigins", () => {
  it("returns only the quick-tunnel wildcard when nothing is configured", () => {
    expect(parseAllowedDevOrigins(undefined)).toEqual(["**.trycloudflare.com"]);
    expect(parseAllowedDevOrigins("")).toEqual(["**.trycloudflare.com"]);
  });

  it("splits, trims and lowercases a comma-separated list", () => {
    expect(parseAllowedDevOrigins(" Dev.Example.com , a.example.org ")).toEqual([
      "dev.example.com",
      "a.example.org",
      "**.trycloudflare.com",
    ]);
  });

  it("drops empty entries and duplicates", () => {
    expect(parseAllowedDevOrigins("a.example.com,,a.example.com,")).toEqual([
      "a.example.com",
      "**.trycloudflare.com",
    ]);
  });

  it("strips a scheme and a port, which the matcher would never match", () => {
    // Next matches only the request's hostname, so `https://x:8765` can never
    // match anything; accepting it as written turns a config typo into a
    // mysterious 403.
    expect(parseAllowedDevOrigins("https://dev.example.com:8765")).toEqual([
      "dev.example.com",
      "**.trycloudflare.com",
    ]);
  });
});
