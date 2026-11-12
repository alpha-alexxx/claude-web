import { describe, expect, it, vi } from "vitest";
import { getPlugins, setPluginEnabled } from "./plugins-client";

/**
 * plugins-client: the browser half of /api/plugins.
 *
 * The id is `name@marketplace`; it is encoded so a proxy cannot read the `@`
 * as something else, and it is sent as ONE path segment. The server re-validates
 * it anyway — that check is the safety rule, this is only URL hygiene.
 */

const VIEW = {
  plugins: [
    {
      id: "frontend-design@anthropic-plugin-directory",
      name: "frontend-design",
      marketplace: "anthropic-plugin-directory",
      version: "1.1.1",
      scope: "user",
      enabled: true,
      provider: "claude",
      installPath: "/home/u/.claude/plugins/x",
      installedAt: null,
      lastUpdated: null,
      compatibleWith: ["claude"],
    },
  ],
  message: null,
  providers: [{ id: "claude", label: "Claude Code", inventory: true }],
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getPlugins", () => {
  it("returns the view", async () => {
    const f = vi.fn(async () => respond(VIEW));
    expect(await getPlugins({ fetch: f })).toEqual({ ok: true, view: VIEW });
  });

  it("rejects a body with no plugin array", async () => {
    const f = vi.fn(async () => respond({ providers: [] }));
    expect(await getPlugins({ fetch: f })).toEqual({ ok: false, code: "invalid_response" });
  });
});

describe("setPluginEnabled", () => {
  it("encodes the id and sends exactly { enabled }", async () => {
    const f = vi.fn(async () => respond({ ok: true }));
    expect((await setPluginEnabled("a@b", false, { fetch: f })).ok).toBe(true);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plugins/a%40b");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
  });

  it("surfaces a CLI failure with its message", async () => {
    const f = vi.fn(async () =>
      respond({ ok: false, code: "cli_failed", message: "plugin not found" }, 502),
    );
    expect(await setPluginEnabled("a@b", true, { fetch: f })).toEqual({
      ok: false,
      code: "cli_failed",
      message: "plugin not found",
    });
  });
});
