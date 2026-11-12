import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientIp } from "../client-ip";
import { clearDummyEnv, useDummyEnv } from "@/test/dummy-env";

/**
 * The client IP feeds the audit log, so what matters is exactly WHERE in
 * `X-Forwarded-For` the value comes from. The chain is
 * `client, proxy1, proxy2` — the client controls the leftmost entries and the
 * nearest proxy appends the truth at the end. Reading the FIRST entry would
 * let any caller write its own audit trail by prefaking the header; this file
 * pins the LAST-entry rule and the TRUST_PROXY gate around it.
 */

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { headers });
}

describe("clientIp", () => {
  beforeEach(() => {
    useDummyEnv({ TRUST_PROXY: "false" });
  });
  afterEach(clearDummyEnv);

  it("returns null without TRUST_PROXY, even with forwarded headers present", () => {
    expect(
      clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })),
    ).toBeNull();
    expect(clientIp(req({ "x-real-ip": "203.0.113.7" }))).toBeNull();
    expect(clientIp(req({}))).toBeNull();
  });

  it("uses the LAST X-Forwarded-For entry when TRUST_PROXY is on", () => {
    useDummyEnv({ TRUST_PROXY: "true" });
    // The client writes 1.2.3.4 itself; the trusted proxy appends 203.0.113.9.
    expect(
      clientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.2, 203.0.113.9" })),
    ).toBe("203.0.113.9");
  });

  it("accepts the TRUST_PROXY=1 spelling", () => {
    useDummyEnv({ TRUST_PROXY: "1" });
    expect(clientIp(req({ "x-forwarded-for": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });

  it("falls back to x-real-ip when the forwarded list is absent", () => {
    useDummyEnv({ TRUST_PROXY: "true" });
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("prefers a usable X-Forwarded-For over x-real-ip", () => {
    useDummyEnv({ TRUST_PROXY: "true" });
    expect(
      clientIp(
        req({
          "x-forwarded-for": "198.51.100.4",
          "x-real-ip": "192.0.2.1",
        }),
      ),
    ).toBe("198.51.100.4");
  });

  it("truncates absurdly long values to 64 characters", () => {
    useDummyEnv({ TRUST_PROXY: "true" });
    const long = `${"a".repeat(100)}.example.com`;
    expect(clientIp(req({ "x-forwarded-for": long }))).toHaveLength(64);
  });

  it("skips whitespace-only entries when choosing the last one", () => {
    useDummyEnv({ TRUST_PROXY: "true" });
    expect(clientIp(req({ "x-forwarded-for": "  , ,198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });
});
