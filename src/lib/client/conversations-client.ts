import type { ConversationSummary } from "@/lib/chat/conversation-view";

/** Re-exported: callers of this module type their rows with its shape. */
export type { ConversationSummary };

/**
 * Browser transport for the conversations REST surface.
 *
 * Every function RESOLVES — a sidebar refresh is not worth an unhandled
 * rejection, and the UI needs a truthful failure rather than an exception.
 * Error codes are passed through verbatim so the caller can distinguish
 * "not yours / gone" (404 → drop the row) from a transient failure (keep it).
 *
 * Ids are encoded into the path: a client id is opaque, and one containing
 * `/` or `?` must never reshape the URL. The server strips its own
 * `${userId}:` prefix, so the id here is exactly what `/chat/[id]` carries.
 */

export interface ListResult {
  ok: boolean;
  conversations: ConversationSummary[];
}

export interface MutationResult {
  ok: boolean;
  /** The server's error code, or "network" for a transport failure. */
  code?: string;
}

export async function listConversations(opts: {
  fetch?: typeof fetch;
} = {}): Promise<ListResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch("/api/conversations", {
      method: "GET",
      // Per-user data behind a cookie: never let a cache answer for another
      // session, whatever an intermediary thinks it is allowed to do.
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, conversations: [] };
    const body = (await res.json()) as { conversations?: unknown };
    if (!Array.isArray(body.conversations)) {
      return { ok: false, conversations: [] };
    }
    return { ok: true, conversations: body.conversations as ConversationSummary[] };
  } catch {
    return { ok: false, conversations: [] };
  }
}

export async function renameConversation(
  id: string,
  title: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<MutationResult> {
  return mutate("PATCH", id, { title }, opts.fetch);
}

export async function deleteConversation(
  id: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<MutationResult> {
  return mutate("DELETE", id, undefined, opts.fetch);
}

// -- internals ---------------------------------------------------------------

async function mutate(
  method: "PATCH" | "DELETE",
  id: string,
  body: unknown,
  doFetchOverride?: typeof fetch,
): Promise<MutationResult> {
  const doFetch = doFetchOverride ?? globalThis.fetch;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await doFetch(`/api/conversations/${encodeURIComponent(id)}`, init);
  } catch {
    return { ok: false, code: "network" };
  }
  if (res.ok) return { ok: true };

  let code = "unknown";
  try {
    const parsed = (await res.json()) as { error?: unknown };
    if (typeof parsed.error === "string") code = parsed.error;
  } catch {
    // The status alone still identifies the failure.
  }
  return { ok: false, code };
}
