import { describe, expect, it, vi } from "vitest";
import { getMcpServers, saveMcpServers, syncMcpToTool } from "./mcp-client";

/**
 * mcp-client: the browser half of /api/mcp and /api/mcp/sync.
 *
 * Pinned: saving sends the registry array and nothing else, syncing sends a
 * TOOL NAME (never a path), and a refusal keeps its reason — that reason names
 * the file the operator has to fix by hand.
 */

const SERVERS = [
  { name: "files", command: "npx", args: ["-y", "server-files"], enabled: true },
  { name: "search", command: "node", args: ["search.js"], enabled: false },
];

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getMcpServers", () => {
  it("returns the registry", async () => {
    const f = vi.fn(async () => respond({ servers: SERVERS }));
    expect(await getMcpServers({ fetch: f })).toEqual({ ok: true, servers: SERVERS });
  });

  it("rejects a body with no servers array", async () => {
    const f = vi.fn(async () => respond({ servers: "nope" }));
    expect(await getMcpServers({ fetch: f })).toEqual({ ok: false, code: "invalid_response" });
  });
});

describe("saveMcpServers", () => {
  it("PUTs { servers } and echoes the canonical list back", async () => {
    const f = vi.fn(async () => respond({ ok: true, servers: SERVERS }));
    expect(await saveMcpServers(SERVERS, { fetch: f })).toEqual({ ok: true, servers: SERVERS });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mcp");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ servers: SERVERS });
  });

  it("falls back to the submitted list when the reply omits it", async () => {
    const f = vi.fn(async () => respond({ ok: true }));
    expect(await saveMcpServers(SERVERS, { fetch: f })).toEqual({ ok: true, servers: SERVERS });
  });

  it("keeps the validation message naming the offending row", async () => {
    const f = vi.fn(async () =>
      respond({ error: "invalid_body", message: "servers.0.name: required" }, 400),
    );
    expect(await saveMcpServers(SERVERS, { fetch: f })).toEqual({
      ok: false,
      code: "invalid_body",
      message: "servers.0.name: required",
    });
  });

  it("keeps a duplicate-name refusal", async () => {
    const f = vi.fn(async () =>
      respond({ error: "duplicate_name", message: 'Two servers are named "files"' }, 400),
    );
    expect(await saveMcpServers(SERVERS, { fetch: f })).toMatchObject({
      ok: false,
      code: "duplicate_name",
    });
  });
});

describe("syncMcpToTool", () => {
  it("sends only the tool name and reports where it wrote", async () => {
    const f = vi.fn(async () =>
      respond({ ok: true, path: "/home/u/.codex/config.toml", count: 1 }),
    );
    expect(await syncMcpToTool("codex", { fetch: f })).toEqual({
      ok: true,
      path: "/home/u/.codex/config.toml",
      count: 1,
    });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/mcp/sync");
    expect(JSON.parse(String(init.body))).toEqual({ tool: "codex" });
  });

  it("surfaces a parse refusal so the page can name the broken file", async () => {
    const f = vi.fn(async () =>
      respond(
        { ok: false, code: "refused", message: "/home/u/.codex/config.toml is not valid TOML" },
        409,
      ),
    );
    expect(await syncMcpToTool("codex", { fetch: f })).toEqual({
      ok: false,
      code: "refused",
      message: "/home/u/.codex/config.toml is not valid TOML",
    });
  });
});
