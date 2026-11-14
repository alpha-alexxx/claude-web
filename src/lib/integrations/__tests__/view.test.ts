import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { setIntegrationEnabled } from "@/lib/db/integrations-repo";
import { writeCredentials } from "../credentials";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import type { Detection } from "../detect";
import type { InstallPlan } from "../installer";
import { integrationsView, pinnedVersionOf } from "../view";

/**
 * The page's read model is where the security rules become a payload, so the
 * assertions below are mostly about what must NOT be in it: no credential
 * values, no absolute binary paths, no "allowed" install while a gate is shut.
 *
 * Detection and the install preflight are mocked at their module boundary —
 * they each spawn a process, and this test is about the join, not the spawn.
 */

vi.mock("../detect", () => ({ detectAll: vi.fn() }));
vi.mock("../installer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../installer")>();
  return { ...actual, planInstall: vi.fn(actual.planInstall) };
});
vi.mock("../disk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../disk")>();
  return { ...actual, npmGlobalPrefix: vi.fn(actual.npmGlobalPrefix) };
});

import { detectAll } from "../detect";
import { planInstall } from "../installer";
import { npmGlobalPrefix } from "../disk";

let tmpDir: string;

const detection = (over: Partial<Detection>): Detection => ({
  id: "codex",
  status: "missing",
  path: null,
  version: null,
  reason: "codex is not on this server's PATH",
  checkedAt: Date.now(),
  ...over,
});

const plan = (over: Partial<InstallPlan> = {}): InstallPlan => ({
  id: "codex",
  spec: "@openai/codex@0.167.0",
  refusal: null,
  reason: null,
  disk: {
    dir: "/usr/local/lib/node_modules",
    freeBytes: 12 * 1024 * 1024 * 1024,
    requiredBytes: 437 * 1024 * 1024 + 512 * 1024 * 1024,
    ok: true,
    reason: null,
  },
  ...over,
});

beforeEach(() => {
  // Call counts are assertions here ("spawned once"), so they must start at 0.
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integrations-view-"));
  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb();

  vi.mocked(detectAll).mockResolvedValue([
    detection({ id: "claude", status: "bundled", reason: null }),
    detection({ id: "codex" }),
    detection({ id: "opencode" }),
    detection({ id: "qoder" }),
  ]);
  vi.mocked(planInstall).mockResolvedValue(plan());
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pinnedVersionOf", () => {
  it("reads the version after the last @", () => {
    expect(pinnedVersionOf("@openai/codex@0.167.0")).toBe("0.167.0");
    expect(pinnedVersionOf("lodash@4.17.21")).toBe("4.17.21");
    expect(pinnedVersionOf("@scope/name@1.0.0-beta.2")).toBe("1.0.0-beta.2");
  });

  it("returns null for no pin or no spec", () => {
    expect(pinnedVersionOf(null)).toBeNull();
    expect(pinnedVersionOf("@scope/name")).toBeNull();
  });
});

describe("integrationsView", () => {
  it("assembles one entry per registry provider", async () => {
    const view = await integrationsView();
    expect(view.integrations.map((i) => i.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "qoder",
    ]);
    expect(view.integrations[0]).toMatchObject({
      id: "claude",
      status: "bundled",
      sizeLabel: "bundled",
      authMethod: "host-login",
      credentialKeys: [],
      credentials: { configured: true, presentKeys: [] },
    });
    expect(view.integrations[1]).toMatchObject({
      id: "codex",
      status: "missing",
      statusReason: "codex is not on this server's PATH",
      sizeLabel: "437 MiB",
      drift: false,
    });
  });

  it("never exposes the absolute binary path or a credential value", async () => {
    writeCredentials(path.join(tmpDir, "app.db"), "codex", {
      OPENAI_API_KEY: "sk-supersecret-value",
    });
    vi.mocked(detectAll).mockResolvedValue([
      detection({ id: "claude", status: "bundled" }),
      detection({
        id: "codex",
        status: "installed",
        path: "/home/ubuntu/.nvm/versions/node/v26/bin/codex",
        version: "0.167.0",
      }),
      detection({ id: "opencode" }),
      detection({ id: "qoder" }),
    ]);

    const view = await integrationsView();
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("sk-supersecret-value");
    expect(wire).not.toContain("/home/ubuntu/.nvm");
    expect(JSON.parse(wire).integrations[1].credentials).toEqual({
      configured: true,
      presentKeys: ["OPENAI_API_KEY"],
    });
  });

  it("flags drift when the installed version is not the pinned one", async () => {
    vi.mocked(detectAll).mockResolvedValue([
      detection({ id: "claude", status: "bundled" }),
      detection({ id: "codex", status: "installed", version: "0.168.0" }),
      detection({ id: "opencode" }),
      detection({ id: "qoder" }),
    ]);
    const view = await integrationsView();
    expect(view.integrations[1].drift).toBe(true);
  });

  it("reports active only when the row is enabled AND the adapter is enabled", async () => {
    // Codex HAS an adapter in this build, but the dummy env enables only
    // claude, so `isEnabled("codex")` fails. Enabling the row is recorded
    // intent, yet chat must still not offer it. Claude is the mirror case:
    // enabled by env, row off.
    vi.mocked(detectAll).mockResolvedValue([
      detection({ id: "claude", status: "bundled" }),
      detection({ id: "codex", status: "installed", version: "0.167.0" }),
      detection({ id: "opencode" }),
      detection({ id: "qoder" }),
    ]);
    setIntegrationEnabled(getBootDb(), "codex", true);

    const view = await integrationsView();
    expect(view.integrations[1]).toMatchObject({
      enabled: true,
      adapterAvailable: false,
      active: false,
    });
    expect(view.integrations[0]).toMatchObject({
      enabled: false,
      adapterAvailable: true,
      active: false,
    });
  });

  it("passes the refresh flag through to detection", async () => {
    await integrationsView({ refresh: true });
    expect(detectAll).toHaveBeenCalledWith({ refresh: true });
  });

  it("surfaces the install plan's refusal and free space", async () => {
    vi.mocked(planInstall).mockResolvedValue(
      plan({
        refusal: "not_allowlisted",
        reason: "@openai/codex@0.167.0 is not in INSTALL_ALLOWLIST",
        disk: {
          dir: "/usr/local/lib/node_modules",
          freeBytes: 3 * 1024 * 1024 * 1024,
          requiredBytes: 1,
          ok: true,
          reason: null,
        },
      }),
    );
    const view = await integrationsView();
    expect(view.integrations[1].install).toEqual({
      spec: "@openai/codex@0.167.0",
      allowed: false,
      refusal: "not_allowlisted",
      reason: "@openai/codex@0.167.0 is not in INSTALL_ALLOWLIST",
      freeLabel: "3.0 GiB",
    });
  });

  it("warns about an allowlist entry the app does not install", async () => {
    useDummyEnv({
      DATABASE_PATH: path.join(tmpDir, "app.db"),
      INSTALL_ALLOWLIST: "@openai/codex@0.167.0,left-pad@1.0.0",
    });
    const view = await integrationsView();
    expect(view.installsEnabled).toBe(true);
    expect(view.allowlistWarning).toContain("left-pad@1.0.0");
    expect(view.allowlistWarning).not.toContain("@openai/codex@0.167.0");
  });

  it("enables installs from the registry pins when INSTALL_ALLOWLIST is unset", async () => {
    // The shipped default: an operator who never sets the key still gets the
    // three pinned installs, and no warning (the derived list is all known).
    const real = await vi.importActual<typeof import("../installer")>("../installer");
    vi.mocked(planInstall).mockImplementation(real.planInstall);
    const prefixDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(prefixDir, { recursive: true });
    vi.mocked(npmGlobalPrefix).mockResolvedValue({ dir: prefixDir, resolved: true });

    const view = await integrationsView();
    expect(view.installsEnabled).toBe(true);
    expect(view.allowlistWarning).toBeNull();
    expect(view.integrations.filter((i) => i.install.allowed)).toHaveLength(3);
  });

  it("reports installs as disabled when the key is explicitly empty", async () => {
    useDummyEnv({
      DATABASE_PATH: path.join(tmpDir, "app.db"),
      INSTALL_ALLOWLIST: "",
    });
    const view = await integrationsView();
    expect(view.installsEnabled).toBe(false);
    expect(view.allowlistWarning).toBeNull();
  });

  it("resolves npm's global prefix once for the whole view", async () => {
    // Each card builds an install plan, and a plan measures free space at the
    // prefix. Unmemoised that is `npm prefix -g` per provider per page focus —
    // three or four npm processes racing the detection probes behind one
    // render. The prefix is a host fact: one answer serves every card.
    const prefixDir = path.join(tmpDir, "node_modules");
    fs.mkdirSync(prefixDir, { recursive: true });
    useDummyEnv({
      DATABASE_PATH: path.join(tmpDir, "app.db"),
      INSTALL_ALLOWLIST:
        "@openai/codex@0.167.0,@opencode/cli@2.2.6,@qoder-ai/qodercli@1.1.86",
    });
    const real = await vi.importActual<typeof import("../installer")>("../installer");
    vi.mocked(planInstall).mockImplementation(real.planInstall);
    vi.mocked(npmGlobalPrefix).mockResolvedValue({ dir: prefixDir, resolved: true });

    const view = await integrationsView();

    expect(view.integrations.filter((i) => i.install.allowed)).toHaveLength(3);
    expect(npmGlobalPrefix).toHaveBeenCalledTimes(1);
  });

  it("does not spawn npm at all when installs are disabled", async () => {
    useDummyEnv({
      DATABASE_PATH: path.join(tmpDir, "app.db"),
      INSTALL_ALLOWLIST: "",
    });
    const real = await vi.importActual<typeof import("../installer")>("../installer");
    vi.mocked(planInstall).mockImplementation(real.planInstall);
    await integrationsView();
    expect(npmGlobalPrefix).not.toHaveBeenCalled();
  });
});
