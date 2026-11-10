/**
 * Which page paths require a signed-in user.
 *
 * Deliberately a small pure module so the Proxy and the tests agree on one
 * definition. Only *pages* live here: API routes authenticate inside each
 * handler (see current-actor.ts) because Clerk's `protect()` answers 404 for
 * non-document requests, and because Next 16 warns that Proxy coverage can be
 * silently lost when routes move.
 */

export const SIGN_IN_URL = "/sign-in";
export const SIGN_UP_URL = "/sign-up";

/** Top-level app surfaces that require a session. */
const PROTECTED_ROOTS = ["/chat", "/skills", "/plugins", "/settings"] as const;

export function isProtectedPage(pathname: string): boolean {
  return PROTECTED_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}
