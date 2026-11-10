import { verifyCsrfToken } from "./csrf";

/**
 * Request-level guards shared by all route handlers. These are pure
 * predicates over the Web Request so they can be unit-tested without a
 * running server.
 */

export interface OriginCheckOptions {
  /** Non-browser clients (curl, health probes) send neither Origin nor
   * Sec-Fetch-Site. Default: false for POST (strict), true for GET. */
  allowMissingHeaders: boolean;
}

/**
 * Origin / Sec-Fetch-Site check. SameSite=Lax already blocks most CSRF, but
 * Lax has edge cases (top-level navigations), so defense in depth:
 *  - Origin present → must match the request URL's origin
 *  - Sec-Fetch-Site present → must not be "cross-site"
 *  - both absent → non-browser client; caller decides via allowMissingHeaders
 */
export function sameOriginOk(
  req: Request,
  requestUrl: URL,
  opts: OriginCheckOptions = { allowMissingHeaders: false },
): boolean {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");

  if (origin !== null) {
    try {
      if (new URL(origin).origin !== requestUrl.origin) return false;
    } catch {
      return false; // malformed Origin
    }
  }
  if (fetchSite !== null) {
    if (fetchSite === "cross-site") return false;
  }
  if (origin === null && fetchSite === null) {
    return opts.allowMissingHeaders;
  }
  return true;
}

export interface CsrfCheckResult {
  ok: boolean;
  reason?: "origin" | "csrf";
}

/**
 * Full non-GET gate: Origin/Sec-Fetch-Site check + HMAC double-submit
 * `X-CSRF-Token` verification. Call after parsing the request URL.
 */
export function checkCsrfOrigin(
  req: Request,
  requestUrl: URL,
  secret: string,
): CsrfCheckResult {
  if (!sameOriginOk(req, requestUrl, { allowMissingHeaders: false })) {
    return { ok: false, reason: "origin" };
  }
  const token = req.headers.get("x-csrf-token");
  if (!token || !verifyCsrfToken(secret, token)) {
    return { ok: false, reason: "csrf" };
  }
  return { ok: true };
}
