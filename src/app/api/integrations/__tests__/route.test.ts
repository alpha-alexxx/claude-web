import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { findIntegration } from "@/lib/db/integrations-repo";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { credentialsPath, credentialStatus } from "@/lib/integrations/credentials";
import { resetPermissionBrokerForTest } from "@/lib/providers/claude/broker";

/**
 * Integrations API — the admin surface for detect / enable / install / auth.
 *
 * What is pinned here is the refusal contract, because every one of these
 * routes ends in a process spawn or a secret write:
 *   - non-admins are refused before any of that;
 *   - a cross-origin POST is refused;
 *   - enabling requires the provider be enabled in env AND installed AND
 *     credentialed, with the missing step named;
 *   - install bodies name a provider + action, never a package;
 *   - auth responses and audit rows carry key NAMES only.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

const detectOne = vi.fn();
vi.mock("@/lib/integrations/detect", () => ({
  detectOne: (...args: unknown[]) => detectOne(...args),
  invalidateDetection: vi.fn(),
  resetDetectionCacheForTest: vi.fn(),
}));

const runInstall = vi.fn();
const runUninstall = vi.fn();
vi.mock("@/lib/integrations/installer", () => ({
  runInstall: (...args: unknown[]) => runInstall(...args),
  runUninstall: (...args: unknown[]) => runUninstall(...args),
}));

const integrationsView = vi.fn();
vi.mock("@/lib/integrations/view", () => ({
  integrationsView: (...args: unknown[]) => integrationsView(...args),
}));

import { GET as getView } from "../route";
import { PATCH as patchIntegration } from "../[id]/route";
import { POST as postInstall } from "../[id]/install/route";
import { POST as postAuth } from "../[id]/auth/route";

const ADMIN = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "admin", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

/**
 * `requireActor` is the gate (its `authorize` rules are unit-tested on their
 * own), so a non-admin reaches a route only as this refusal — the routes must
 * render it verbatim and do none of the work behind it.
 */
const FORBIDDEN = {
  ok: false,
  status: 403,
  code: "forbidden",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

let tmpDir: string;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return {
    method,
    url: `http://localhost/api/integrations`,
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function auditActions(): string[] {
  const rows = getBootDb()
    .prepare("SELECT action FROM audit_log ORDER BY id")
    .all() as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integrations-api-"));
  useDummyEnv({
    DATABASE_PATH: path.join(tmpDir, "app.db"),
    ENABLED_PROVIDERS: "claude,codex",
    INSTALL_ALLOWLIST: "@openai/codex@0.167.0",
  });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'admin')")
    .run("user_1", "a@b.c");
  resetRateLimits();
  resetPermissionBrokerForTest();
  vi.mocked(requireActor).mockResolvedValue(ADMIN);
  detectOne.mockResolvedValue({
    id: "codex",
    status: "installed",
    path: "/usr/local/bin/codex",
    version: "0.167.0",
    reason: null,
    checkedAt: Date.now(),
  });
  integrationsView.mockResolvedValue({
    integrations: [{ id: "codex" }],
    installsEnabled: true,
    allowlistWarning: null,
  });
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("GET /api/integrations", () => {
  it("returns the whole view to an admin, uncached", async () => {
    const res = await getView(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ installsEnabled: true });
    expect(integrationsView).toHaveBeenCalledWith({ refresh: false });
  });

  it("passes ?refresh=1 through", async () => {
    await getView(req("GET", undefined, {}) as never);
    await getView({
      ...req("GET"),
      url: "http://localhost/api/integrations?refresh=1",
    } as unknown as Request);
    expect(integrationsView).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("refuses a non-admin with 403", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    const res = await getView(req("GET"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(integrationsView).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with 401", async () => {
    vi.mocked(requireActor).mockResolvedValue({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    expect((await getView(req("GET"))).status).toBe(401);
  });

  it("rate-limits a loop of reads before spawning another probe", async () => {
    // A `?refresh=1` read spawns `--version` per CLI; an unattended tab that
    // polls it must be capped rather than allowed to build a process storm.
    for (let i = 0; i < 30; i += 1) {
      expect((await getView(req("GET"))).status).toBe(200);
    }
    const capped = await getView({
      ...req("GET"),
      url: "http://localhost/api/integrations?refresh=1",
    } as unknown as Request);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "rate_limited" });
    expect(capped.headers.get("retry-after")).toMatch(/^\d+$/);
    // The capped request never reached the detector.
    expect(integrationsView).toHaveBeenCalledTimes(30);
  });
});

describe("PATCH /api/integrations/[id]", () => {
  it("enables a detected, credentialed provider", async () => {
    const { writeCredentials } = await import("@/lib/integrations/credentials");
    writeCredentials(path.join(tmpDir, "app.db"), "codex", { OPENAI_API_KEY: "sk-test" });

    const res = await patchIntegration(req("PATCH", { enabled: true }), ctx("codex") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, enabled: true });
    expect(findIntegration(getBootDb(), "codex")).toMatchObject({ enabled: true });
    expect(auditActions()).toContain("integration.enable");
  });

  it("refuses Claude — its state comes from ENABLED_PROVIDERS", async () => {
    const res = await patchIntegration(req("PATCH", { enabled: false }), ctx("claude") as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "not_toggleable" });
  });

  it("404s an unknown provider", async () => {
    const res = await patchIntegration(req("PATCH", { enabled: true }), ctx("nope") as never);
    expect(res.status).toBe(404);
  });

  it("409s with the missing step when the provider is not in ENABLED_PROVIDERS", async () => {
    const res = await patchIntegration(req("PATCH", { enabled: true }), ctx("opencode") as never);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_in_enabled_providers");
    expect(body.message).toContain("ENABLED_PROVIDERS");
  });

  it("409s when the binary is missing, quoting detection's reason", async () => {
    detectOne.mockResolvedValue({
      id: "codex",
      status: "missing",
      path: null,
      version: null,
      reason: "codex is not on this server's PATH",
      checkedAt: Date.now(),
    });
    const res = await patchIntegration(req("PATCH", { enabled: true }), ctx("codex") as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "not_installed",
      message: "codex is not on this server's PATH",
    });
    expect(findIntegration(getBootDb(), "codex")).toBeNull();
  });

  it("409s when there are no credentials yet", async () => {
    const res = await patchIntegration(req("PATCH", { enabled: true }), ctx("codex") as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_authenticated" });
  });

  it("disables without requiring the binary or credentials", async () => {
    const { writeCredentials } = await import("@/lib/integrations/credentials");
    writeCredentials(path.join(tmpDir, "app.db"), "codex", { OPENAI_API_KEY: "sk-test" });
    await patchIntegration(req("PATCH", { enabled: true }), ctx("codex") as never);
    detectOne.mockClear();

    const res = await patchIntegration(req("PATCH", { enabled: false }), ctx("codex") as never);
    expect(res.status).toBe(200);
    expect(detectOne).not.toHaveBeenCalled();
    expect(findIntegration(getBootDb(), "codex")).toMatchObject({ enabled: false });
  });

  it("rejects a malformed body and a cross-origin request", async () => {
    expect(
      (await patchIntegration(req("PATCH", { enabled: "yes" }), ctx("codex") as never)).status,
    ).toBe(400);
    expect((await patchIntegration(req("PATCH", undefined), ctx("codex") as never)).status).toBe(
      400,
    );
    const cross = await patchIntegration(
      req("PATCH", { enabled: true }, { origin: "http://evil.example" }),
      ctx("codex") as never,
    );
    expect(cross.status).toBe(403);
  });

  it("refuses a non-admin", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect(
      (await patchIntegration(req("PATCH", { enabled: true }), ctx("codex") as never)).status,
    ).toBe(403);
  });
});

describe("POST /api/integrations/[id]/install", () => {
  beforeEach(() => {
    runInstall.mockResolvedValue({
      ok: true,
      id: "codex",
      code: "installed",
      detail: "@openai/codex@0.167.0 installed",
      audit: { spec: "@openai/codex@0.167.0", exitCode: 0 },
    });
    runUninstall.mockResolvedValue({
      ok: true,
      id: "codex",
      code: "installed",
      detail: "@openai/codex removed",
      audit: { package: "@openai/codex", exitCode: 0 },
    });
  });

  it("runs an install with the registry flow and audits start + ok", async () => {
    const res = await postInstall(req("POST", { action: "install" }), ctx("codex") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, code: "installed" });
    expect(runInstall).toHaveBeenCalledWith("codex", { allowlist: ["@openai/codex@0.167.0"] });
    expect(auditActions()).toEqual([
      "integration.install.start",
      "integration.install.ok",
    ]);
  });

  it("runs an uninstall through runUninstall", async () => {
    const res = await postInstall(req("POST", { action: "uninstall" }), ctx("codex") as never);
    expect(res.status).toBe(200);
    expect(runUninstall).toHaveBeenCalledWith("codex");
    expect(auditActions()).toEqual([
      "integration.uninstall.start",
      "integration.uninstall.ok",
    ]);
  });

  it("409s a refusal and still records it", async () => {
    runInstall.mockResolvedValue({
      ok: false,
      id: "codex",
      code: "refused",
      detail: "@openai/codex@0.167.0 is not in INSTALL_ALLOWLIST",
      audit: { refusal: "not_allowlisted" },
    });
    const res = await postInstall(req("POST", { action: "install" }), ctx("codex") as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "install_refused" });
    expect(auditActions()).toEqual([
      "integration.install.start",
      "integration.install.failed",
    ]);
  });

  it("502s a failed install with npm's message", async () => {
    runInstall.mockResolvedValue({
      ok: false,
      id: "codex",
      code: "failed",
      detail: "ENOSPC: no space left on device",
      audit: { exitCode: 1 },
    });
    const res = await postInstall(req("POST", { action: "install" }), ctx("codex") as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, detail: "ENOSPC: no space left on device" });
  });

  it("drops an unknown id before spawning anything", async () => {
    expect((await postInstall(req("POST", { action: "install" }), ctx("nope") as never)).status).toBe(
      404,
    );
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("rejects a package-ish body — only action install|uninstall is accepted", async () => {
    const res = await postInstall(
      req("POST", { action: "install", spec: "left-pad@1.0.0" }),
      ctx("codex") as never,
    );
    // Extra keys are dropped by zod's object; the spec can never reach npm.
    expect(res.status).toBe(200);
    expect(runInstall).toHaveBeenCalledWith("codex", { allowlist: ["@openai/codex@0.167.0"] });

    expect((await postInstall(req("POST", { action: "rm -rf" }), ctx("codex") as never)).status).toBe(
      400,
    );
    expect((await postInstall(req("POST", undefined), ctx("codex") as never)).status).toBe(400);
  });

  it("rate-limits after five attempts in the hour", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await postInstall(req("POST", { action: "install" }), ctx("codex") as never)).status).toBe(
        200,
      );
    }
    const res = await postInstall(req("POST", { action: "install" }), ctx("codex") as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(runInstall).toHaveBeenCalledTimes(5);
  });

  it("refuses a cross-origin request and a non-admin", async () => {
    const cross = await postInstall(
      req("POST", { action: "install" }, { origin: "http://evil.example" }),
      ctx("codex") as never,
    );
    expect(cross.status).toBe(403);
    expect(runInstall).not.toHaveBeenCalled();

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect(
      (await postInstall(req("POST", { action: "install" }), ctx("codex") as never)).status,
    ).toBe(403);
  });
});

describe("POST /api/integrations/[id]/auth", () => {
  it("writes the declared key and returns names only", async () => {
    const res = await postAuth(
      req("POST", { values: { OPENAI_API_KEY: "sk-live-abc123" } }),
      ctx("codex") as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: { configured: boolean; presentKeys: string[] } };
    expect(body.credentials).toEqual({ configured: true, presentKeys: ["OPENAI_API_KEY"] });
    expect(JSON.stringify(body)).not.toContain("sk-live-abc123");

    // Stored 0600, under the data dir, and never echoed in the audit row.
    const file = credentialsPath(path.join(tmpDir, "app.db"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const audit = getBootDb()
      .prepare("SELECT detail_json FROM audit_log WHERE action = 'integration.auth.set'")
      .get() as { detail_json: string };
    expect(audit.detail_json).toContain("OPENAI_API_KEY");
    expect(audit.detail_json).not.toContain("sk-live-abc123");
  });

  it("clears a provider's credentials", async () => {
    await postAuth(
      req("POST", { values: { OPENAI_API_KEY: "sk-live-abc123" } }),
      ctx("codex") as never,
    );
    const res = await postAuth(req("POST", { clear: true }), ctx("codex") as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ credentials: { configured: false } });
    expect(credentialStatus(path.join(tmpDir, "app.db"), "codex").configured).toBe(false);
    expect(auditActions()).toContain("integration.auth.clear");
  });

  it("rejects a key the provider does not declare", async () => {
    const res = await postAuth(
      req("POST", { values: { ANTHROPIC_API_KEY: "sk-ant-nope" } }),
      ctx("codex") as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid" });
    expect(credentialStatus(path.join(tmpDir, "app.db"), "codex").presentKeys).toEqual([]);
  });

  it("rejects a value that would forge another line", async () => {
    const res = await postAuth(
      req("POST", { values: { OPENAI_API_KEY: "sk-ok\nEVIL=1" } }),
      ctx("codex") as never,
    );
    expect(res.status).toBe(400);
  });

  it("refuses Claude — it uses the host login", async () => {
    const res = await postAuth(
      req("POST", { values: { ANTHROPIC_API_KEY: "sk-ant-x" } }),
      ctx("claude") as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_credentials" });
  });

  it("404s an unknown provider and 400s a malformed body", async () => {
    expect((await postAuth(req("POST", { values: {} }), ctx("nope") as never)).status).toBe(404);
    expect((await postAuth(req("POST", undefined), ctx("codex") as never)).status).toBe(400);
    expect(
      (await postAuth(req("POST", { values: { OPENAI_API_KEY: 5 } }), ctx("codex") as never)).status,
    ).toBe(400);
  });

  it("refuses a cross-origin request and a non-admin", async () => {
    const cross = await postAuth(
      req("POST", { values: { OPENAI_API_KEY: "sk-x" } }, { origin: "http://evil.example" }),
      ctx("codex") as never,
    );
    expect(cross.status).toBe(403);
    expect(credentialStatus(path.join(tmpDir, "app.db"), "codex").presentKeys).toEqual([]);

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect(
      (await postAuth(req("POST", { values: { OPENAI_API_KEY: "sk-x" } }), ctx("codex") as never))
        .status,
    ).toBe(403);
  });
});
