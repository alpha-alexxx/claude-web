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

/**
 * Documented body ceilings (SECURITY.md, "Body limits and validation").
 *
 * `general` covers bodies whose legitimate payload can be large — a turn's
 * text, a settings file the editor just round-tripped, a list of MCP servers.
 * `mutation` covers the small ones — a title, a model name, an enum, a
 * boolean, a handful of credential fields.
 */
export const BODY_CAPS = {
  general: 1_000_000,
  mutation: 64 * 1024,
  /** A permission answer is `{ decision }` — nothing else belongs there. */
  answer: 4 * 1024,
  /** A render request is one path or one URL. */
  render: 16 * 1024,
} as const;

/**
 * True when the request DECLARES a body larger than `max`.
 *
 * This is a declared-length check, run before `req.json()`: the point is that
 * an oversized body costs one header read instead of being buffered into
 * memory and then rejected by zod. A request with no `content-length`
 * (chunked) is not caught here — the per-route zod bounds still apply, and
 * every route that can receive a chunked body is authenticated and
 * same-origin guarded.
 *
 * Lives here rather than in each route for the same reason as `sameOrigin`:
 * one definition, so no route ends up quietly weaker than its neighbours.
 */
export function bodyTooLarge(req: Request, max: number = BODY_CAPS.mutation): boolean {
  const declared = Number(req.headers.get("content-length") ?? "0");
  // `Number("garbage")` is NaN and `NaN > max` is false — an unparseable
  // header falls through to the zod bounds rather than rejecting the request.
  return declared > max;
}
