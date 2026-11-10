import { describe, it, expect } from "vitest";
import { checkCsrfOrigin, sameOriginOk } from "../guard";
import { issueCsrfToken } from "../csrf";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(url, { method, headers });
}

describe("sameOriginOk (Origin / Sec-Fetch-Site check)", () => {
  const host = "http://127.0.0.1:8765";

  it("accepts when Origin matches the request host", () => {
    const req = makeRequest(`${host}/api/auth/login`, {
      origin: host,
      "sec-fetch-site": "same-origin",
    });
    expect(sameOriginOk(req, new URL(host))).toBe(true);
  });

  it("accepts when Origin is absent but Sec-Fetch-Site is same-origin", () => {
    const req = makeRequest(`${host}/api/x`, {
      "sec-fetch-site": "same-origin",
    });
    expect(sameOriginOk(req, new URL(host))).toBe(true);
  });

  it("accepts same-site (e.g. same registrable domain behind a proxy)", () => {
    const req = makeRequest(`${host}/api/x`, {
      origin: "https://app.example.com",
      "sec-fetch-site": "same-site",
    });
    expect(
      sameOriginOk(req, new URL("https://app.example.com")),
    ).toBe(true);
  });

  it("rejects cross-site Origin", () => {
    const req = makeRequest(`${host}/api/x`, {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(sameOriginOk(req, new URL(host))).toBe(false);
  });

  it("rejects when Origin host differs from request host", () => {
    const req = makeRequest(`${host}/api/x`, {
      origin: "http://127.0.0.1:9999",
    });
    expect(sameOriginOk(req, new URL(host))).toBe(false);
  });

  it("rejects browser-declared cross-site even without Origin", () => {
    const req = makeRequest(`${host}/api/x`, {
      "sec-fetch-site": "cross-site",
    });
    expect(sameOriginOk(req, new URL(host))).toBe(false);
  });

  it("accepts non-browser clients (no Origin, no Sec-Fetch headers) only when configured", () => {
    // curl / health checks send neither header; default policy accepts them
    // on GET but the caller decides for POST. Here we test the raw predicate.
    const req = makeRequest(`${host}/api/x`, {});
    expect(sameOriginOk(req, new URL(host), { allowMissingHeaders: true })).toBe(
      true,
    );
    expect(sameOriginOk(req, new URL(host), { allowMissingHeaders: false })).toBe(
      false,
    );
  });
});

describe("checkCsrfOrigin (combined POST gate)", () => {
  const host = "http://127.0.0.1:8765";
  const secret = "0123456789abcdef0123456789abcdef0123456789abcdef";

  it("passes with good Origin + valid CSRF header", () => {
    const tok = issueCsrfToken(secret);
    const req = makeRequest(`${host}/api/x`, {
      origin: host,
      "x-csrf-token": tok,
    });
    expect(checkCsrfOrigin(req, new URL(host), secret).ok).toBe(true);
  });

  it("fails with good Origin but missing CSRF header", () => {
    const req = makeRequest(`${host}/api/x`, { origin: host });
    const r = checkCsrfOrigin(req, new URL(host), secret);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/csrf/i);
  });

  it("fails with valid CSRF header but cross-site Origin", () => {
    const tok = issueCsrfToken(secret);
    const req = makeRequest(`${host}/api/x`, {
      origin: "https://evil.example",
      "x-csrf-token": tok,
    });
    const r = checkCsrfOrigin(req, new URL(host), secret);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/origin/i);
  });
});
