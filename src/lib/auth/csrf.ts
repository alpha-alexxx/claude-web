import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HMAC double-submit CSRF token: `<nonce>.<hmac(nonce)>` where the HMAC key
 * is the server's SESSION_SECRET. The client receives the token via
 * GET /api/auth/csrf and echoes it in the `X-CSRF-Token` header; the server
 * re-derives the HMAC. Combined with SameSite=Lax cookies and an
 * Origin/Sec-Fetch-Site check in the route guard this blocks cross-site
 * POSTs even if a subdomain is compromised.
 */
export const CSRF_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function sign(secret: string, nonce: string): string {
  return createHmac("sha256", secret).update(nonce).digest("base64url");
}

export function issueCsrfToken(secret: string, now: number = Date.now()): string {
  // nonce embeds issue time so expiry needs no server-side storage
  const nonce = `${now.toString(36)}.${randomBytes(16).toString("base64url")}`;
  return `${nonce}.${sign(secret, nonce)}`;
}

export function verifyCsrfToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false; // issuedAt.nonce.signature
  const [issuedB36, noncePart, signature] = parts;

  const issuedMs = Number.parseInt(issuedB36, 36);
  if (!Number.isFinite(issuedMs)) return false;
  if (now - issuedMs > CSRF_TTL_MS || now + 60_000 < issuedMs) return false; // expired or from the future

  const nonce = `${issuedB36}.${noncePart}`;
  const expected = sign(secret, nonce);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
