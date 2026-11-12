/**
 * Shared browser-side HTTP plumbing for the admin surfaces.
 *
 * Two rules, both of them load-bearing:
 *
 *   - Every call RESOLVES. A settings page with five cards must not become a
 *     white screen because one request rejected.
 *   - The server's code and message survive verbatim. The gates (allowlists,
 *     detection, parse checks, refuse-to-clobber) live in the route; the card's
 *     only honest job is to repeat which one said no.
 *
 * The failure field is `error` on auth-gate responses and `code` on refusals
 * (`{ok:false, code:"refused", message}`), so both are read — a client that
 * only looked at `error` would turn every refusal into `http_409`.
 */

export type ApiFailure = { ok: false; code: string; message?: string };

export type ApiResult = { ok: true; body: unknown } | ApiFailure;

/** A request that never reached the server, or never answered. */
export const NETWORK_FAILURE: ApiFailure = { ok: false, code: "network" };

/** The body could not be read at all (not JSON, empty). */
export const INVALID_RESPONSE: ApiFailure = { ok: false, code: "invalid_response" };

export async function getJson(
  path: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<ApiResult> {
  return send(path, { method: "GET", cache: "no-store" }, doFetch);
}

export async function sendJson(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<ApiResult> {
  return send(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
    doFetch,
  );
}

/** Read a successful body as an object, or report a failure it cannot use. */
export function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function failureFrom(body: unknown, status: number): ApiFailure {
  const record = asRecord(body);
  const code =
    typeof record?.error === "string"
      ? record.error
      : typeof record?.code === "string"
        ? record.code
        : `http_${status}`;
  return {
    ok: false,
    code,
    message: typeof record?.message === "string" ? record.message : undefined,
  };
}

// -- internals ---------------------------------------------------------------

async function send(
  path: string,
  init: RequestInit,
  doFetch: typeof fetch,
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await doFetch(path, init);
  } catch {
    return NETWORK_FAILURE;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) return failureFrom(body, res.status);
  if (body === null) return INVALID_RESPONSE;
  return { ok: true, body };
}
