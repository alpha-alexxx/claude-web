import { describe, it, expect, vi } from "vitest";
import {
  clearCredentials,
  getIntegrations,
  installIntegration,
  setCredentials,
  setIntegrationEnabled,
  uninstallIntegration,
} from "./integrations-client";
import type { IntegrationsView } from "@/lib/integrations/types";

/**
 * integrations-client: the browser half of /api/integrations.
 *
 * Contract pinned:
 * - ids are URL-encoded (a provider id is opaque; it must never reshape a path)
 * - mutations send exactly the declared body — `{ enabled }`, `{ action }`,
 *   `{ values }` or `{ clear: true }` — never a package name or an extra key
 * - every call resolves (never rejects): a settings card that throws breaks
 *   the whole page for one failed toggle
 * - the server's code AND message survive, because the gates live server-side
 *   and the card's only honest job is to repeat which one refused
 * - a credential response carries the names-only status and nothing else
 */

const VIEW = {
  integrations: [
    {
      id: "codex",
      label: "Codex",
      description: "OpenAI's coding agent.",
      docsUrl: "https://developers.openai.com/codex",
      authMethod: "device-code",
      sizeLabel: "437 MiB",
      status: "missing",
      version: null,
      drift: false,
      statusReason: "codex is not on this server's PATH",
      enabled: false,
      adapterAvailable: false,
      active: false,
      credentials: { configured: false, presentKeys: [] },
      credentialKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
      install: {
        spec: "@openai/codex@0.167.0",
        allowed: false,
        refusal: "installs_disabled",
        reason: "Server-side installs are disabled (INSTALL_ALLOWLIST is empty)",
        freeLabel: null,
      },
    },
  ],
  installsEnabled: false,
  allowlistWarning: null,
} as unknown as IntegrationsView;

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getIntegrations", () => {
  it("returns the view, uncached", async () => {
    const f = vi.fn(async () => jsonResponse(VIEW));
    const result = await getIntegrations({ fetch: f });
    expect(result).toEqual({ ok: true, view: VIEW });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/integrations");
    expect(init.cache).toBe("no-store");
  });

  it("asks for a cache-bypassing refresh when told to", async () => {
    const f = vi.fn(async () => jsonResponse(VIEW));
    await getIntegrations({ refresh: true, fetch: f });
    expect(f).toHaveBeenCalledWith("/api/integrations?refresh=1", expect.anything());
  });

  it("reports the server's refusal code", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "forbidden" }, 403));
    expect(await getIntegrations({ fetch: f })).toEqual({
      ok: false,
      code: "forbidden",
      message: undefined,
    });
  });

  it("resolves to a failure on a network error and on a malformed body", async () => {
    expect(
      await getIntegrations({
        fetch: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    ).toEqual({ ok: false, code: "network" });

    expect(
      await getIntegrations({ fetch: vi.fn(async () => jsonResponse({ nope: true })) }),
    ).toEqual({ ok: false, code: "invalid_response" });
  });
});

describe("setIntegrationEnabled", () => {
  it("PATCHes an encoded id with exactly { enabled }", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true, enabled: true }));
    const result = await setIntegrationEnabled("co/dex", true, { fetch: f });
    expect(result.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/integrations/co%2Fdex");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });

  it("surfaces the gate that refused, message included", async () => {
    const f = vi.fn(async () =>
      jsonResponse(
        { error: "not_authenticated", message: "Codex has no credentials yet" },
        409,
      ),
    );
    expect(await setIntegrationEnabled("codex", true, { fetch: f })).toEqual({
      ok: false,
      code: "not_authenticated",
      message: "Codex has no credentials yet",
    });
  });
});

describe("install / uninstall", () => {
  it("sends an action, never a package spec", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true, code: "installed" }));
    expect((await installIntegration("codex", { fetch: f })).ok).toBe(true);
    expect((await uninstallIntegration("codex", { fetch: f })).ok).toBe(true);

    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe("/api/integrations/codex/install");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ action: "install" });
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ action: "uninstall" });
  });

  it("passes an install refusal through unchanged", async () => {
    const f = vi.fn(async () =>
      jsonResponse(
        { error: "install_refused", message: "@openai/codex@0.167.0 is not in INSTALL_ALLOWLIST" },
        409,
      ),
    );
    expect(await installIntegration("codex", { fetch: f })).toMatchObject({
      ok: false,
      code: "install_refused",
    });
  });
});

describe("credentials", () => {
  it("posts values one way and returns the names-only status", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ ok: true, credentials: { configured: true, presentKeys: ["OPENAI_API_KEY"] } }),
    );
    const result = await setCredentials("codex", { OPENAI_API_KEY: "sk-live" }, { fetch: f });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/integrations/codex/auth");
    expect(JSON.parse(String(init.body))).toEqual({ values: { OPENAI_API_KEY: "sk-live" } });
    expect(result).toEqual({
      ok: true,
      credentials: { configured: true, presentKeys: ["OPENAI_API_KEY"] },
    });
  });

  it("clears with a flag rather than an empty value map", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ ok: true, credentials: { configured: false, presentKeys: [] } }),
    );
    await clearCredentials("codex", { fetch: f });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ clear: true });
  });

  it("resolves to a failure instead of throwing", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await setCredentials("codex", { OPENAI_API_KEY: "x" }, { fetch: f })).toEqual({
      ok: false,
      code: "network",
    });
  });
});
