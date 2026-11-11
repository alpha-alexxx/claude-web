/**
 * Request-level guards shared by API routes. Kept out of the routes so the
 * CSRF rule has exactly one definition — a second copy is how one route ends
 * up subtly weaker than the others.
 */

/**
 * Same-origin check for state-changing requests.
 *
 * Browsers always attach Origin to cross-site POSTs, so a mismatched Origin
 * means a cross-site page is driving this request — refuse it. A missing
 * Origin means a non-browser client (curl, a CLI, tests); that is not a CSRF
 * vector because no ambient browser credentials are involved, and the route's
 * own authentication still applies.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
