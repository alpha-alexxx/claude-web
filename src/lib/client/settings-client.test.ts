import { describe, expect, it, vi } from "vitest";
import { getSettings, saveSettings } from "./settings-client";

/**
 * settings-client: the browser half of /api/settings/[tool].
 *
 * The load-bearing case is the unparseable read: the server returns
 * `parsed: false` with `text: ""` rather than echoing a file that may hold a
 * secret. The client must pass that through intact, because an editor that
 * read the empty text as "this file is empty" would offer to save over the
 * operator's real config.
 */

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getSettings", () => {
  it("returns a clean file's text", async () => {
    const settings = {
      path: "/home/u/.codex/config.toml",
      exists: true,
      text: 'model = "gpt-5"\n',
      value: { model: "gpt-5" },
      parsed: true,
    };
    const f = vi.fn(async () => respond(settings));
    expect(await getSettings("codex", { fetch: f })).toEqual({ ok: true, settings });
    expect(f).toHaveBeenCalledWith(
      "/api/settings/codex",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("passes an unparseable read through, empty text included", async () => {
    const settings = {
      path: "/home/u/.claude/settings.json",
      exists: true,
      text: "",
      value: {},
      parsed: false,
      message: "settings.json is not valid JSON",
    };
    const f = vi.fn(async () => respond(settings));
    expect(await getSettings("claude", { fetch: f })).toEqual({ ok: true, settings });
  });

  it("rejects a body that is not a settings read", async () => {
    const f = vi.fn(async () => respond({ path: "/x" }));
    expect(await getSettings("qoder", { fetch: f })).toEqual({
      ok: false,
      code: "invalid_response",
    });
  });

  it("keeps an unknown-tool 404", async () => {
    const f = vi.fn(async () => respond({ error: "unknown_tool" }, 404));
    expect(await getSettings("claude", { fetch: f })).toMatchObject({
      ok: false,
      code: "unknown_tool",
    });
  });
});

describe("saveSettings", () => {
  it("PUTs the raw text and reports the backup", async () => {
    const f = vi.fn(async () =>
      respond({ ok: true, path: "/home/u/.claude/settings.json", backup: "/x.bak-1" }),
    );
    expect(await saveSettings("claude", '{"a":1}', { fetch: f })).toEqual({
      ok: true,
      path: "/home/u/.claude/settings.json",
      backup: "/x.bak-1",
    });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/settings/claude");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ text: '{"a":1}' });
  });

  it("reports a no-op save as a null backup", async () => {
    const f = vi.fn(async () => respond({ ok: true, path: "/p", backup: null }));
    expect(await saveSettings("codex", 'model = "x"', { fetch: f })).toEqual({
      ok: true,
      path: "/p",
      backup: null,
    });
  });

  it("keeps the refusal code and message so the editor can show why", async () => {
    const f = vi.fn(async () =>
      respond(
        { ok: false, code: "stored_unparseable", message: "the stored file does not parse" },
        400,
      ),
    );
    expect(await saveSettings("claude", "{}", { fetch: f })).toEqual({
      ok: false,
      code: "stored_unparseable",
      message: "the stored file does not parse",
    });
  });
});
