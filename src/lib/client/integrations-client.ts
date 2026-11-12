import type {
  CredentialStatus,
  IntegrationsView,
} from "@/lib/integrations/types";

/** Re-exported: callers of this module type their cards with its shape. */
export type { IntegrationsView };

/**
 * Browser transport for the admin Integrations surface.
 *
 * Every function RESOLVES — a settings page is not worth an unhandled
 * rejection, and the card needs a truthful failure it can show. The server's
 * error code and human `message` are passed through verbatim: the gates here
 * are server-side by design (allowlist, disk, detection, credentials), and the
 * UI's job is to say which one refused, not to re-implement the check.
 *
 * Nothing in this module ever carries a credential VALUE out. `setCredentials`
 * sends values one way; the response is the names-only status, and that is
 * what the card renders.
 */

/** The failure half, shared by the view read and every mutation. */
type Failure = {
  ok: false;
  /** Server code (`not_installed`, `install_refused`, …), or "network". */
  code: string;
  /** The server's explanation, shown verbatim when present. */
  message?: string;
};

/** The view itself, or why it could not be read. */
export type IntegrationsResult =
  | { ok: true; view: IntegrationsView }
  | Failure;

/** Outcome of a mutation (toggle / install / credentials). */
export type ActionOutcome =
  | {
      ok: true;
      /** Credential status after an auth write, names only. */
      credentials?: CredentialStatus;
    }
  | Failure;

export async function getIntegrations(
  opts: { refresh?: boolean; fetch?: typeof fetch } = {},
): Promise<IntegrationsResult> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const url = opts.refresh ? "/api/integrations?refresh=1" : "/api/integrations";

  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", cache: "no-store" });
  } catch {
    return { ok: false, code: "network" };
  }

  const body = await readJson(res);
  if (!res.ok) return failure(body, res.status);
  if (!body || !Array.isArray((body as { integrations?: unknown }).integrations)) {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, view: body as unknown as IntegrationsView };
}

/** Enable or disable a provider. The server enforces the prerequisite gates. */
export async function setIntegrationEnabled(
  id: string,
  enabled: boolean,
  opts: { fetch?: typeof fetch } = {},
): Promise<ActionOutcome> {
  return mutate(
    `/api/integrations/${encodeURIComponent(id)}`,
    "PATCH",
    { enabled },
    opts.fetch,
  );
}

export async function installIntegration(
  id: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<ActionOutcome> {
  return mutate(
    `/api/integrations/${encodeURIComponent(id)}/install`,
    "POST",
    { action: "install" },
    opts.fetch,
  );
}

export async function uninstallIntegration(
  id: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<ActionOutcome> {
  return mutate(
    `/api/integrations/${encodeURIComponent(id)}/install`,
    "POST",
    { action: "uninstall" },
    opts.fetch,
  );
}

/**
 * Write declared credential keys. `values` is a KEY → value map; the provider
 * refuses any key it does not declare, so this cannot be a general secret
 * writer. `clear` removes the provider's keys instead.
 */
export async function setCredentials(
  id: string,
  values: Record<string, string>,
  opts: { fetch?: typeof fetch } = {},
): Promise<ActionOutcome> {
  return mutate(
    `/api/integrations/${encodeURIComponent(id)}/auth`,
    "POST",
    { values },
    opts.fetch,
  );
}

export async function clearCredentials(
  id: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<ActionOutcome> {
  return mutate(
    `/api/integrations/${encodeURIComponent(id)}/auth`,
    "POST",
    { clear: true },
    opts.fetch,
  );
}

// -- internals ---------------------------------------------------------------

async function mutate(
  path: string,
  method: "PATCH" | "POST",
  body: unknown,
  doFetchOverride?: typeof fetch,
): Promise<ActionOutcome> {
  const doFetch = doFetchOverride ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { ok: false, code: "network" };
  }

  const parsed = await readJson(res);
  if (res.ok) {
    const record = parsed as { credentials?: CredentialStatus } | null;
    return { ok: true, credentials: record?.credentials };
  }
  return failure(parsed, res.status);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function failure(parsed: unknown, status: number): Failure {
  const record = parsed as { error?: unknown; message?: unknown } | null;
  return {
    ok: false,
    code: typeof record?.error === "string" ? record.error : `http_${status}`,
    message: typeof record?.message === "string" ? record.message : undefined,
  };
}
