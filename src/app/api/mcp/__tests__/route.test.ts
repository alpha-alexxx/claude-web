import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * MCP API — the app's registry and the per-tool generators.
 *
 * The registry is `data/mcp-servers.json` (next to the database, so the temp
 * DATABASE_PATH puts it inside the fixture) and the generated files live under
 * a mocked home directory. Both are real files on a real disk: what is pinned
 * here is that a bad row never reaches either, and that a sync into a tool
 * whose own config is broken refuses instead of overwriting it.
 *
 * The audit assertion is deliberate: the registry holds server credentials in
 * `env`, so a row that echoed them would be a leak even though the UI redacts.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

let fakeHome = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { GET as getRegistry, PUT as putRegistry } from "../route";
import { POST as postSync } from "../sync/route";

const ADMIN = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "admin", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const FORBIDDEN = {
  ok: false,
  status: 403,
  code: "forbidden",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

let tmpDir: string;

function req(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return {
    method,
    url: "http://localhost/api/mcp",
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function server(overrides: Record<string, unknown> = {}) {
  return { name: "files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], ...overrides };
}

function registryPath(): string {
  return path.join(tmpDir, "mcp-servers.json");
}

function auditRows(): Array<{ action: string; detail: string }> {
  return getBootDb()
    .prepare("SELECT action, detail_json AS detail FROM audit_log ORDER BY id")
    .all() as Array<{ action: string; detail: string }>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-api-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });

  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'admin')")
    .run("user_1", "a@b.c");
  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(ADMIN);
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("GET /api/mcp", () => {
  it("is empty before anything is written", async () => {
    const res = await getRegistry();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: [] });
  });

  it("drops an invalid stored row rather than repairing it", async () => {
    fs.writeFileSync(
      registryPath(),
      JSON.stringify([server(), { name: "../evil", command: "x" }, { name: "bare" }]),
    );
    const body = (await (await getRegistry()).json()) as { servers: Array<{ name: string }> };
    expect(body.servers.map((s) => s.name)).toEqual(["files"]);
  });

  it("refuses a non-admin", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await getRegistry()).status).toBe(403);
  });
});

describe("PUT /api/mcp", () => {
  it("writes the registry 0600 and audits names only", async () => {
    const res = await putRegistry(
      req("PUT", {
        servers: [server({ env: { API_TOKEN: "s3cr3t-value" } })],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });

    const mode = fs.statSync(registryPath()).mode & 0o777;
    expect(mode).toBe(0o600);

    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual(["mcp.registry.write"]);
    expect(rows[0]!.detail).toContain("files");
    // The credential is in the registry, not in the record of who wrote it.
    expect(rows[0]!.detail).not.toContain("s3cr3t-value");
  });

  it("round-trips through GET", async () => {
    await putRegistry(req("PUT", { servers: [server()] }));
    const body = (await (await getRegistry()).json()) as {
      servers: Array<{ name: string; args: string[]; enabled: boolean }>;
    };
    expect(body.servers).toEqual([
      { name: "files", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], enabled: true },
    ]);
  });

  it("names the offending row instead of a generic 400", async () => {
    const res = await putRegistry(req("PUT", { servers: [server({ name: " ../evil" })] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_body");
    expect(body.message).toMatch(/^servers\.0\.name: /);
    expect(fs.existsSync(registryPath())).toBe(false);
  });

  it("rejects two servers with the same name in any casing", async () => {
    const res = await putRegistry(
      req("PUT", { servers: [server({ name: "Files" }), server({ name: "files" })] }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "duplicate_name",
    });
  });

  it("rejects a body that is not a server list", async () => {
    expect((await putRegistry(req("PUT", undefined))).status).toBe(400);
    expect((await putRegistry(req("PUT", { servers: "nope" }))).status).toBe(400);
    expect((await putRegistry(req("PUT", { servers: [{ name: "x" }] }))).status).toBe(400);
  });

  it("refuses a cross-origin write without touching the file", async () => {
    const res = await putRegistry(
      req("PUT", { servers: [server()] }, { origin: "http://evil.example" }),
    );
    expect(res.status).toBe(403);
    expect(fs.existsSync(registryPath())).toBe(false);
  });

  it("rate-limits a client that keeps rewriting the list", async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await putRegistry(req("PUT", { servers: [server()] }))).status).toBe(200);
    }
    const res = await putRegistry(req("PUT", { servers: [server()] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("POST /api/mcp/sync", () => {
  async function seed(servers: unknown[]): Promise<void> {
    expect((await putRegistry(req("PUT", { servers }))).status).toBe(200);
  }

  it("generates Claude's JSON shape and reports where it wrote", async () => {
    await seed([server()]);
    const res = await postSync(req("POST", { tool: "claude" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string; count: number };
    expect(body.ok).toBe(true);
    expect(body.path).toBe(path.join(fakeHome, ".claude.json"));
    expect(body.count).toBe(1);

    const written = JSON.parse(fs.readFileSync(body.path, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(written.mcpServers.files!.command).toBe("npx");
    expect(auditRows().map((r) => r.action)).toEqual(["mcp.registry.write", "mcp.sync.claude.ok"]);
  });

  it("omits a disabled server from the generated file", async () => {
    await seed([server({ name: "on" }), server({ name: "off", enabled: false })]);
    const body = (await (await postSync(req("POST", { tool: "claude" }))).json()) as {
      count: number;
    };
    expect(body.count).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers)).toEqual(["on"]);
  });

  it("generates OpenCode's separate dialect", async () => {
    await seed([server({ env: { TOKEN: "v" } })]);
    expect((await postSync(req("POST", { tool: "opencode" }))).status).toBe(200);

    const written = JSON.parse(
      fs.readFileSync(path.join(fakeHome, ".config", "opencode", "opencode.json"), "utf8"),
    ) as { mcp: Record<string, { command: string[]; environment: Record<string, string> }> };
    expect(written.mcp.files!.command[0]).toBe("npx");
    expect(written.mcp.files!.environment).toEqual({ TOKEN: "v" });
  });

  it("generates Codex TOML and preserves the rest of the file", async () => {
    const codexDir = path.join(fakeHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "gpt-5"\n\n[mcp_servers.hand]\ncommand = "keep-me"\n');
    await seed([server()]);

    expect((await postSync(req("POST", { tool: "codex" }))).status).toBe(200);
    const written = fs.readFileSync(configPath, "utf8");
    expect(written).toContain('model = "gpt-5"');
    expect(written).toContain('command = "keep-me"');
    expect(written).toContain("[mcp_servers.files]");

    // Idempotent: a second sync does not stack a duplicate table.
    expect((await postSync(req("POST", { tool: "codex" }))).status).toBe(200);
    const again = fs.readFileSync(configPath, "utf8");
    expect(again.split("[mcp_servers.files]")).toHaveLength(2);
  });

  it("refuses rather than overwrite a tool config that does not parse", async () => {
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{ not json");
    await seed([server()]);

    const res = await postSync(req("POST", { tool: "claude" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("refused");
    expect(body.message).toContain(".claude.json is not valid JSON");
    // The operator's broken file is exactly as they left it.
    expect(fs.readFileSync(path.join(fakeHome, ".claude.json"), "utf8")).toBe("{ not json");
    expect(auditRows().map((r) => r.action)).toContain("mcp.sync.claude.failed");
  });

  it("refuses a Codex config that does not parse as TOML", async () => {
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), "not = = toml");
    await seed([server()]);

    const res = await postSync(req("POST", { tool: "codex" }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { message: string }).toMatchObject({
      message: expect.stringContaining("not valid TOML"),
    });
  });

  it("names a tool, never a path", async () => {
    await seed([server()]);
    const res = await postSync(req("POST", { tool: "/etc/passwd" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });

  it("refuses a cross-origin sync and a non-admin", async () => {
    await seed([server()]);
    expect(
      (await postSync(req("POST", { tool: "claude" }, { origin: "http://evil.example" }))).status,
    ).toBe(403);
    expect(fs.existsSync(path.join(fakeHome, ".claude.json"))).toBe(false);

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await postSync(req("POST", { tool: "claude" }))).status).toBe(403);
  });

  it("rate-limits repeated syncs", async () => {
    await seed([server()]);
    for (let i = 0; i < 20; i += 1) {
      expect((await postSync(req("POST", { tool: "claude" }))).status).toBe(200);
    }
    expect((await postSync(req("POST", { tool: "claude" }))).status).toBe(429);
  });
});
