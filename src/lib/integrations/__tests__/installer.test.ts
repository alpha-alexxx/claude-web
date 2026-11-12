import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  packageNameOf,
  planInstall,
  resolveNpm,
  runInstall,
  runUninstall,
  createNpmRunner,
  type NpmRunner,
} from "../installer";
import type { RunOptions, RunResult } from "@/lib/exec/run";

/**
 * Installs are the sharpest edge in the app: an argv array into a global
 * package manager. These tests pin the four independent gates (registry pin,
 * allowlist, resolved npm binary, disk preflight), that a refusal runs
 * nothing, and that the argv handed to npm is exactly what the registry says.
 */

const MiB = 1024 * 1024;

const ok = (stdout = ""): RunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
  error: null,
});

function spyRunner(result: RunResult = ok()) {
  const installs: { spec: string; options: RunOptions }[] = [];
  const uninstalls: { pkg: string; options: RunOptions }[] = [];
  const runner: NpmRunner = {
    install: async (spec, options) => {
      installs.push({ spec, options });
      return result;
    },
    uninstall: async (pkg, options) => {
      uninstalls.push({ pkg, options });
      return result;
    },
  };
  return { runner, installs, uninstalls };
}

/** Every path that a call needs supplied so nothing touches the real host. */
const sandbox = (over: { freeBytes?: number; allowlist?: string[] } = {}) => ({
  allowlist: over.allowlist ?? ["@openai/codex@0.167.0"],
  npmPath: "/usr/bin/npm",
  prefixDir: "/usr/local/lib/node_modules",
  freeBytes: over.freeBytes ?? 50_000 * MiB,
});

describe("planInstall", () => {
  it("refuses installs when INSTALL_ALLOWLIST is empty", async () => {
    const plan = await planInstall("codex", { ...sandbox(), allowlist: [] });
    expect(plan.refusal).toBe("installs_disabled");
    expect(plan.reason).toContain("INSTALL_ALLOWLIST");
  });

  it("refuses a spec that is not in the allowlist, naming it", async () => {
    const plan = await planInstall("codex", {
      ...sandbox(),
      allowlist: ["@openai/codex@0.166.0"],
    });
    expect(plan.refusal).toBe("not_allowlisted");
    expect(plan.reason).toContain("@openai/codex@0.167.0");
  });

  it("requires the full pinned spec — a bare package name is not enough", async () => {
    const plan = await planInstall("codex", {
      ...sandbox(),
      allowlist: ["@openai/codex"],
    });
    expect(plan.refusal).toBe("not_allowlisted");
  });

  it("refuses when npm is not on PATH", async () => {
    const plan = await planInstall("codex", { ...sandbox(), npmPath: null });
    expect(plan.refusal).toBe("npm_not_found");
  });

  it("refuses when the disk cannot take the package plus the reserve", async () => {
    const plan = await planInstall("codex", {
      ...sandbox(),
      freeBytes: 437 * MiB + 512 * MiB - 1,
    });
    expect(plan.refusal).toBe("insufficient_disk");
    expect(plan.reason).toContain("available");
  });

  it("passes with the reserve exactly met", async () => {
    const plan = await planInstall("codex", {
      ...sandbox(),
      freeBytes: 437 * MiB + 512 * MiB,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.spec).toBe("@openai/codex@0.167.0");
    expect(plan.disk?.ok).toBe(true);
  });

  it("treats Claude as not installable rather than missing", async () => {
    const plan = await planInstall("claude", sandbox());
    expect(plan.refusal).toBe("not_installable");
  });

  it("rejects an id outside the registry", async () => {
    const plan = await planInstall("nope" as never, sandbox());
    expect(plan.refusal).toBe("unknown_provider");
  });
});

describe("runInstall", () => {
  it("runs nothing when the plan refuses", async () => {
    const { runner, installs } = spyRunner();
    const outcome = await runInstall("codex", {
      ...sandbox(),
      allowlist: [],
      runner,
    });
    expect(outcome.code).toBe("refused");
    expect(outcome.ok).toBe(false);
    expect(installs).toHaveLength(0);
  });

  it("hands npm the registry's exact spec and only that spec", async () => {
    const { runner, installs } = spyRunner();
    const outcome = await runInstall("codex", { ...sandbox(), runner });
    expect(outcome.code).toBe("installed");
    expect(outcome.ok).toBe(true);
    expect(installs.map((i) => i.spec)).toEqual(["@openai/codex@0.167.0"]);
    expect(installs[0].options.timeoutMs).toBe(10 * 60_000);
    expect(outcome.audit).toMatchObject({ spec: "@openai/codex@0.167.0", exitCode: 0 });
  });

  it("reports a failed install with npm's stderr, bounded", async () => {
    const stderr = "E404 not found ".repeat(200);
    const { runner } = spyRunner({
      code: 1,
      stdout: "",
      stderr,
      timedOut: false,
      truncated: false,
      error: null,
    });
    const outcome = await runInstall("codex", { ...sandbox(), runner });
    expect(outcome.code).toBe("failed");
    expect(outcome.ok).toBe(false);
    expect(outcome.detail.length).toBeLessThanOrEqual(500);
  });

  it("treats a timed-out install as failed even with a zero exit", async () => {
    const { runner } = spyRunner({
      code: 0,
      stdout: "",
      stderr: "",
      timedOut: true,
      truncated: false,
      error: null,
    });
    const outcome = await runInstall("codex", { ...sandbox(), runner });
    expect(outcome.code).toBe("failed");
    expect(outcome.detail).toBe("install timed out");
  });

  it("never records a credential-shaped value in the audit detail", async () => {
    const { runner } = spyRunner({
      code: 1,
      stdout: "",
      stderr: "auth failed for sk-ant-api03-secret",
      timedOut: false,
      truncated: false,
      error: null,
    });
    const outcome = await runInstall("codex", { ...sandbox(), runner });
    // stderr is a UI detail; the audit payload must stay free of it.
    expect(JSON.stringify(outcome.audit)).not.toContain("sk-ant");
  });
});

describe("runUninstall", () => {
  it("removes the package by its unversioned name", async () => {
    const { runner, uninstalls } = spyRunner();
    const outcome = await runUninstall("codex", { runner, npmPath: "/usr/bin/npm" });
    expect(outcome.ok).toBe(true);
    expect(uninstalls.map((u) => u.pkg)).toEqual(["@openai/codex"]);
    expect(outcome.audit).toMatchObject({ package: "@openai/codex" });
  });

  it("refuses to uninstall the bundled provider", async () => {
    const { runner, uninstalls } = spyRunner();
    const outcome = await runUninstall("claude", { runner });
    expect(outcome.code).toBe("refused");
    expect(uninstalls).toHaveLength(0);
  });
});

describe("packageNameOf", () => {
  it("strips only the trailing version, keeping the scope", () => {
    expect(packageNameOf("@openai/codex@0.167.0")).toBe("@openai/codex");
    expect(packageNameOf("@opencode/cli@2.2.6")).toBe("@opencode/cli");
    expect(packageNameOf("left-pad@1.0.0")).toBe("left-pad");
    expect(packageNameOf("left-pad")).toBe("left-pad");
  });
});

describe("resolveNpm", () => {
  it("skips non-executable candidates and empty PATH segments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "npm"), "");
    const notExec = () => false;
    expect(resolveNpm(`${path.delimiter}${bin}`, notExec)).toBeNull();
    const isExec = (p: string) => p === path.join(bin, "npm");
    expect(resolveNpm(`${path.delimiter}${bin}`, isExec)).toBe(path.join(bin, "npm"));
  });
});

describe("createNpmRunner", () => {
  it("pins the argv shape: install -g, the spec, then non-interactive flags", async () => {
    // A fake npm that records argv would require a real spawn; instead call
    // the runner against a shell script that echoes its arguments.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-run-"));
    const fake = path.join(dir, "npm");
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const runner = createNpmRunner(fake);
    const out = await runner.install("@openai/codex@0.167.0", { timeoutMs: 5000 });
    expect(out.code).toBe(0);
    expect(out.stdout.trim().split("\n")).toEqual([
      "install",
      "-g",
      "@openai/codex@0.167.0",
      "--no-fund",
      "--no-audit",
    ]);
  });

  it("passes a spec containing shell metacharacters as a single literal arg", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-run-"));
    const fake = path.join(dir, "npm");
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const runner = createNpmRunner(fake);
    const out = await runner.uninstall('evil; echo pwned', { timeoutMs: 5000 });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('evil; echo pwned');
    expect(out.stdout).not.toContain("pwned\npwned");
  });
});
