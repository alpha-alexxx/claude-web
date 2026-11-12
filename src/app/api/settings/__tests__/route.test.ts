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
 * Settings API — per-tool settings files, read redacted and written safely.
 *
 * This is the one API that holds a live credential in its payload by
 * definition, so the tests spend most of their effort on the two ways it could
 * destroy one:
 *
 *   - a GET must never echo a secret, and must not echo a file it could not
 *     parse at all (the parse is what redacts);
 *   - a PUT carrying the `***` marker back must restore the stored value, not
 *     write the literal marker;
 *   - an open-and-save of an unchanged file must not rewrite it.
 *
 * The audit rows are checked for the same reason: they record that a write
 * happened, never what was in it.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

let fakeHome = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { GET, PUT } from "../[tool]/route";

const ADMIN = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "admin", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const FORBIDDEN = {
  ok: false,
  status: 403,
  code: "forbidden",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const SECRET = "sk-live-do-not-leak";

let tmpDir: string;

function req(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return {
    method,
    url: "http://localhost/api/settings/claude",
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function ctx(tool: string) {
  return { params: Promise.resolve({ tool }) };
}

function claudeSettings(): string {
  return path.join(fakeHome, ".claude", "settings.json");
}

function writeClaude(content: string): void {
  fs.mkdirSync(path.dirname(claudeSettings()), { recursive: true });
  fs.writeFileSync(claudeSettings(), content);
}

function auditRows(): Array<{ action: string }> {
  return getBootDb().prepare("SELECT action FROM audit_log ORDER BY id").all() as Array<{
    action: string;
  }>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-api-"));
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

describe("GET /api/settings/[tool]", () => {
  it("reports a missing file as an empty document, not an error", async () => {
    const res = await GET(req("GET"), ctx("claude"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      path: claudeSettings(),
      exists: false,
      text: "",
      parsed: true,
    });
  });

  it("redacts a secret by key name at any depth", async () => {
    writeClaude(
      JSON.stringify({
        model: "sonnet",
        env: { ANTHROPIC_API_KEY: SECRET, LOG_LEVEL: "debug" },
        mcpServers: { s: { env: { GH_TOKEN: SECRET } } },
      }),
    );
    const res = await GET(req("GET"), ctx("claude"));
    const body = (await res.json()) as {
      text: string;
      value: { env: Record<string, string>; mcpServers: { s: { env: Record<string, string> } } };
    };
    expect(JSON.stringify(body.value)).not.toContain(SECRET);
    expect(body.text).not.toContain(SECRET);
    expect(body.value.env.LOG_LEVEL).toBe("debug");
    expect(body.value.env.ANTHROPIC_API_KEY).toBe("***");
    expect(body.value.mcpServers.s.env.GH_TOKEN).toBe("***");
  });

  it("shows a clean file byte-for-byte, keeping TOML comments", async () => {
    writeClaude('{\n  "model": "sonnet"\n}\n');
    const body = (await (await GET(req("GET"), ctx("claude"))).json()) as { text: string };
    expect(body.text).toBe('{\n  "model": "sonnet"\n}\n');
  });

  it("refuses to echo a file it cannot parse", async () => {
    writeClaude(`{ "env": { "ANTHROPIC_API_KEY": "${SECRET}" `);
    const res = await GET(req("GET"), ctx("claude"));
    const body = (await res.json()) as { text: string; parsed: boolean; message: string };
    expect(res.status).toBe(200);
    expect(body.parsed).toBe(false);
    // The whole point: the unparseable bytes are exactly where the secret is.
    expect(body.text).toBe("");
    expect(body.message).toContain("Not valid JSON");
  });

  it("reads Codex as TOML", async () => {
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5"\napi_key = "toml-secret"\n',
    );
    const body = (await (await GET(req("GET"), ctx("codex"))).json()) as {
      value: Record<string, unknown>;
      text: string;
    };
    expect(body.value.model).toBe("gpt-5");
    expect(body.value.api_key).toBe("***");
    expect(body.text).not.toContain("toml-secret");
  });

  it("404s an unknown tool and refuses a non-admin", async () => {
    expect((await GET(req("GET"), ctx("nope"))).status).toBe(404);

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await GET(req("GET"), ctx("claude"))).status).toBe(403);
  });
});

describe("PUT /api/settings/[tool]", () => {
  it("creates a missing file and backs nothing up", async () => {
    const res = await PUT(req("PUT", { text: '{ "model": "sonnet" }\n' }), ctx("claude"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; backup: string | null };
    expect(body.ok).toBe(true);
    expect(body.backup).toBeNull();
    expect(JSON.parse(fs.readFileSync(claudeSettings(), "utf8"))).toEqual({ model: "sonnet" });
    expect(fs.statSync(claudeSettings()).mode & 0o777).toBe(0o600);
    expect(auditRows().map((r) => r.action)).toEqual(["settings.write.claude.ok"]);
  });

  it("restores a secret posted back as the marker instead of writing ***", async () => {
    writeClaude(JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET } }, null, 2));

    const res = await PUT(
      req("PUT", { text: JSON.stringify({ env: { ANTHROPIC_API_KEY: "***" }, model: "opus" }) }),
      ctx("claude"),
    );
    expect(res.status).toBe(200);

    const stored = JSON.parse(fs.readFileSync(claudeSettings(), "utf8")) as {
      env: Record<string, string>;
      model: string;
    };
    expect(stored.env.ANTHROPIC_API_KEY).toBe(SECRET);
    expect(stored.model).toBe("opus");
  });

  it("uses a typed value in place of the marker", async () => {
    writeClaude(JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET } }));
    await PUT(req("PUT", { text: JSON.stringify({ env: { ANTHROPIC_API_KEY: "replaced" } }) }), ctx("claude"));
    const stored = JSON.parse(fs.readFileSync(claudeSettings(), "utf8")) as {
      env: Record<string, string>;
    };
    expect(stored.env.ANTHROPIC_API_KEY).toBe("replaced");
  });

  it("keeps a timestamped backup and preserves the file mode", async () => {
    fs.mkdirSync(path.dirname(claudeSettings()), { recursive: true });
    fs.writeFileSync(claudeSettings(), '{\n  "model": "sonnet"\n}\n', { mode: 0o640 });
    fs.chmodSync(claudeSettings(), 0o640);

    const res = await PUT(req("PUT", { text: '{"model":"opus"}' }), ctx("claude"));
    const body = (await res.json()) as { backup: string };
    expect(body.backup).toMatch(/\.bak-/);
    expect(fs.readFileSync(body.backup, "utf8")).toBe('{\n  "model": "sonnet"\n}\n');
    expect(fs.statSync(claudeSettings()).mode & 0o777).toBe(0o640);
  });

  it("treats an unchanged save as a no-op", async () => {
    const original = '{\n  "model":    "sonnet"\n}\n';
    writeClaude(original);
    const res = await PUT(req("PUT", { text: original }), ctx("claude"));
    expect(res.status).toBe(200);
    expect((await res.json()) as { backup: unknown }).toMatchObject({ backup: null });
    // Not even reformatted.
    expect(fs.readFileSync(claudeSettings(), "utf8")).toBe(original);
    expect(fs.readdirSync(path.dirname(claudeSettings()))).toEqual(["settings.json"]);
  });

  it("rejects text that does not parse without touching the file", async () => {
    writeClaude('{"model":"sonnet"}');
    const res = await PUT(req("PUT", { text: "{ model: sonnet" }), ctx("claude"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_settings");
    expect(body.message).toContain("Not valid JSON");
    expect(fs.readFileSync(claudeSettings(), "utf8")).toBe('{"model":"sonnet"}');
    expect(auditRows().map((r) => r.action)).toEqual(["settings.write.claude.invalid_settings"]);
  });

  it("rejects a JSON array as a settings document", async () => {
    const res = await PUT(req("PUT", { text: "[1,2,3]" }), ctx("claude"));
    expect(res.status).toBe(400);
    expect((await res.json()) as { message: string }).toMatchObject({
      message: expect.stringContaining("must be a JSON object"),
    });
  });

  it("refuses to replace a stored file that does not parse", async () => {
    writeClaude(`{ "env": { "k": "${SECRET}" `);
    const res = await PUT(req("PUT", { text: '{"model":"opus"}' }), ctx("claude"));
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "stored_unparseable" });
    // Still exactly as broken, and still exactly as secret.
    expect(fs.readFileSync(claudeSettings(), "utf8")).toContain(SECRET);
  });

  it("answers 500 when the filesystem refuses the write", async () => {
    // A settings file that is really a directory: the atomic rename cannot
    // replace it. That is a server-side problem the editor's text cannot fix,
    // so it must not come back as a 400 — the panel would tell the operator to
    // fix text that was never the issue.
    fs.mkdirSync(claudeSettings(), { recursive: true });

    const res = await PUT(req("PUT", { text: '{"model":"opus"}' }), ctx("claude"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("write_failed");
    expect(body.message).toMatch(/EISDIR|ENOTDIR|EEXIST/);
  });

  it("validates TOML for Codex", async () => {
    const res = await PUT(req("PUT", { text: "model = = nope" }), ctx("codex"));
    expect(res.status).toBe(400);
    expect((await res.json()) as { message: string }).toMatchObject({
      message: expect.stringContaining("Not valid TOML"),
    });

    expect((await PUT(req("PUT", { text: 'model = "gpt-5"\n' }), ctx("codex"))).status).toBe(200);
    expect(
      fs.readFileSync(path.join(fakeHome, ".codex", "config.toml"), "utf8"),
    ).toBe('model = "gpt-5"\n');
  });

  it("rejects an oversized body and a missing one", async () => {
    const big = "x".repeat(512 * 1024 + 1);
    expect((await PUT(req("PUT", { text: big }), ctx("claude"))).status).toBe(400);
    expect((await PUT(req("PUT", undefined), ctx("claude"))).status).toBe(400);
  });

  it("never records a secret value in the audit log", async () => {
    writeClaude(JSON.stringify({ env: { ANTHROPIC_API_KEY: SECRET } }));
    await PUT(
      req("PUT", { text: JSON.stringify({ env: { ANTHROPIC_API_KEY: "***" }, extra: true }) }),
      ctx("claude"),
    );
    const rows = getBootDb().prepare("SELECT detail_json AS d FROM audit_log").all() as Array<{
      d: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.d).not.toContain(SECRET);
  });

  it("refuses a cross-origin write and a non-admin", async () => {
    expect(
      (await PUT(req("PUT", { text: "{}" }, { origin: "http://evil.example" }), ctx("claude")))
        .status,
    ).toBe(403);
    expect(fs.existsSync(claudeSettings())).toBe(false);

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await PUT(req("PUT", { text: "{}" }), ctx("claude"))).status).toBe(403);
  });

  it("rate-limits a loop of saves", async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await PUT(req("PUT", { text: `{"n":${i}}` }), ctx("claude"))).status).toBe(200);
    }
    expect((await PUT(req("PUT", { text: '{"n":999}' }), ctx("claude"))).status).toBe(429);
  });
});
