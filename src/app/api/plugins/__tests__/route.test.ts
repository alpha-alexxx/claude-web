import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { runArgv, type RunResult } from "@/lib/exec/run";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * Plugins API — the unified listing and the enable/disable toggle.
 *
 * Both routes shell out to the Claude CLI, so `runArgv` is mocked and the
 * tests assert on ARGV, not on a command string: the security property is that
 * an id reaches the child as one argument with no shell in between. An id that
 * could be read as a flag is refused before the spawn.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/exec/run", () => ({ runArgv: vi.fn() }));

import { GET as getPlugins } from "../route";
import { POST as postPlugin } from "../[id]/route";

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
    url: "http://localhost/api/plugins/x",
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function run(overrides: Partial<RunResult> = {}): RunResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    error: null,
    ...overrides,
  };
}

function auditActions(): string[] {
  return (
    getBootDb().prepare("SELECT action FROM audit_log ORDER BY id").all() as Array<{
      action: string;
    }>
  ).map((r) => r.action);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-api-"));
  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'admin')")
    .run("user_1", "a@b.c");
  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(ADMIN);
  vi.mocked(runArgv).mockResolvedValue(run());
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("GET /api/plugins", () => {
  it("lists what the CLI reports, with compat labels from the manifests", async () => {
    const installPath = path.join(tmpDir, "plugin-a");
    fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
    vi.mocked(runArgv).mockResolvedValue(
      run({
        stdout: JSON.stringify([
          {
            id: "alpha@market",
            version: "1.2.3",
            scope: "user",
            enabled: true,
            installPath,
          },
        ]),
      }),
    );

    const res = await getPlugins();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plugins: Array<{ id: string; name: string; marketplace: string; compatibleWith: string[] }>;
      message: string | null;
      providers: Array<{ id: string; inventory: boolean }>;
    };
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({
      id: "alpha@market",
      name: "alpha",
      marketplace: "market",
      compatibleWith: ["claude"],
    });
    expect(body.message).toBeNull();
    expect(body.providers.find((p) => p.id === "codex")?.inventory).toBe(false);
    expect(vi.mocked(runArgv).mock.calls[0]?.[1]).toEqual(["plugin", "list", "--json"]);
  });

  it("still renders the page with an explanation when the CLI is missing", async () => {
    vi.mocked(runArgv).mockResolvedValue(run({ code: null, error: "spawn claude ENOENT" }));

    const res = await getPlugins();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: unknown[]; message: string };
    expect(body.plugins).toEqual([]);
    expect(body.message).toContain("Could not run the Claude CLI");
  });

  it("reports unreadable output rather than claiming there are no plugins", async () => {
    vi.mocked(runArgv).mockResolvedValue(run({ stdout: "not json at all" }));
    const body = (await (await getPlugins()).json()) as { message: string };
    expect(body.message).toContain("could not read");
  });

  it("refuses a non-admin without spawning anything", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await getPlugins()).status).toBe(403);
    expect(vi.mocked(runArgv)).not.toHaveBeenCalled();
  });
});

describe("POST /api/plugins/[id]", () => {
  it("passes the id as one argv entry, never a shell string", async () => {
    const res = await postPlugin(req("POST", { enabled: true }), ctx("alpha@market"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(vi.mocked(runArgv)).toHaveBeenCalledTimes(1);
    const [bin, argv, options] = vi.mocked(runArgv).mock.calls[0]!;
    expect(bin).toBe("claude");
    expect(argv).toEqual(["plugin", "enable", "alpha@market"]);
    expect(options).toMatchObject({ timeoutMs: 60_000 });
    expect(auditActions()).toEqual(["plugin.enable.ok"]);
  });

  it("disables when asked", async () => {
    await postPlugin(req("POST", { enabled: false }), ctx("alpha"));
    expect(vi.mocked(runArgv).mock.calls[0]?.[1]).toEqual(["plugin", "disable", "alpha"]);
    expect(auditActions()).toEqual(["plugin.disable.ok"]);
  });

  it("refuses an id that could be read as a flag", async () => {
    for (const id of ["--version", "-x", "a b", "a/b", "x@y@z", ""]) {
      // The bucket is 5/hour and is checked before the id is parsed — refusing
      // to spend the quota is the guard's job, not this test's subject.
      resetRateLimits();
      const res = await postPlugin(req("POST", { enabled: true }), ctx(id));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_plugin_id" });
    }
    expect(vi.mocked(runArgv)).not.toHaveBeenCalled();
  });

  it("requires a boolean, not a truthy string", async () => {
    expect((await postPlugin(req("POST", { enabled: "yes" }), ctx("a"))).status).toBe(400);
    expect((await postPlugin(req("POST", undefined), ctx("a"))).status).toBe(400);
    expect(vi.mocked(runArgv)).not.toHaveBeenCalled();
  });

  it("502s a missing CLI and records the failure", async () => {
    vi.mocked(runArgv).mockResolvedValue(run({ code: null, error: "spawn claude ENOENT" }));
    const res = await postPlugin(req("POST", { enabled: true }), ctx("alpha"));
    expect(res.status).toBe(502);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "cli_missing" });
    expect(auditActions()).toEqual(["plugin.enable.failed"]);
  });

  it("502s a nonzero exit with the CLI's own first line", async () => {
    vi.mocked(runArgv).mockResolvedValue(
      run({ code: 1, stderr: "\n  plugin alpha not found\nmore detail\n" }),
    );
    const res = await postPlugin(req("POST", { enabled: false }), ctx("alpha"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      code: "cli_failed",
      message: "plugin alpha not found",
    });
  });

  it("refuses a cross-origin write and a non-admin", async () => {
    expect(
      (await postPlugin(req("POST", { enabled: true }, { origin: "http://evil.example" }), ctx("a")))
        .status,
    ).toBe(403);
    expect(vi.mocked(runArgv)).not.toHaveBeenCalled();

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await postPlugin(req("POST", { enabled: true }), ctx("a"))).status).toBe(403);
    expect(vi.mocked(runArgv)).not.toHaveBeenCalled();
  });

  it("uses the install bucket, so a toggle loop is limited", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await postPlugin(req("POST", { enabled: true }), ctx("a"))).status).toBe(200);
    }
    const res = await postPlugin(req("POST", { enabled: true }), ctx("a"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(vi.mocked(runArgv)).toHaveBeenCalledTimes(5);
  });
});
