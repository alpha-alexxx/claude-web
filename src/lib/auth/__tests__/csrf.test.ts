import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { issueCsrfToken, verifyCsrfToken, CSRF_TTL_MS } from "../csrf";

const SECRET = "test-secret-at-least-32-bytes-long!!!!";

describe("issueCsrfToken", () => {
  it("returns a token of the form <issued-at>.<nonce>.<hmac>", () => {
    const tok = issueCsrfToken(SECRET);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("binds the HMAC to the secret", () => {
    const tok = issueCsrfToken(SECRET);
    const [issuedB36, nonce, sig] = tok.split(".");
    const nonceFull = `${issuedB36}.${nonce}`;
    const other = createHmac("sha256", "a-different-secret-32-bytes!!!!!!")
      .update(nonceFull)
      .digest("base64url");
    expect(sig).not.toBe(other);
  });
});

describe("verifyCsrfToken", () => {
  it("accepts a freshly issued token", () => {
    const tok = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(SECRET, tok, Date.now())).toBe(true);
  });

  it("rejects a token signed with a different secret", () => {
    const tok = issueCsrfToken("another-secret-32-bytes-long!!!!!!!");
    expect(verifyCsrfToken(SECRET, tok, Date.now())).toBe(false);
  });

  it("rejects a tampered nonce", () => {
    const tok = issueCsrfToken(SECRET);
    const [nonce, sig] = tok.split(".");
    const tampered = `${nonce}x.${sig}`;
    expect(verifyCsrfToken(SECRET, tampered, Date.now())).toBe(false);
  });

  it("rejects tokens older than the TTL", () => {
    const tok = issueCsrfToken(SECRET);
    const future = Date.now() + CSRF_TTL_MS + 1000;
    expect(verifyCsrfToken(SECRET, tok, future)).toBe(false);
  });

  it("accepts tokens right up to the TTL boundary", () => {
    const tok = issueCsrfToken(SECRET);
    const nearFuture = Date.now() + CSRF_TTL_MS - 1000;
    expect(verifyCsrfToken(SECRET, tok, nearFuture)).toBe(true);
  });

  it("rejects garbage without throwing", () => {
    expect(verifyCsrfToken(SECRET, "", Date.now())).toBe(false);
    expect(verifyCsrfToken(SECRET, "no-dot", Date.now())).toBe(false);
    expect(verifyCsrfToken(SECRET, "a.b.c", Date.now())).toBe(false);
    expect(verifyCsrfToken(SECRET, "!!invalid-base64!!.$$$", Date.now())).toBe(
      false,
    );
  });
});
