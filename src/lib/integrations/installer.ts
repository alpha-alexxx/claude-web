import "server-only";
import fs from "node:fs";
import path from "node:path";
import { runArgv, type RunOptions, type RunResult } from "@/lib/exec/run";
import { getEnv } from "@/lib/env";
import { integrationSpec } from "./registry";
import { planDisk, freeBytesAt, npmGlobalPrefix, type DiskPlan } from "./disk";
import type { ProviderId } from "@/lib/providers/types";
import type { InstallRefusal } from "./types";

/** `data/` lives next to the database file — one place, not two. */
function dataDir(): string {
  return path.dirname(getEnv().DATABASE_PATH);
}

/** Re-exported: a refusal is rendered by the card, so it is a wire type. */
export type { InstallRefusal };

/**
 * Pinned install / uninstall for third-party CLIs.
 *
 * Every gate in this file exists in the plan's security section, and they are
 * deliberately redundant:
 *
 *   - the package spec comes ONLY from the registry (never from a request);
 *   - it must ALSO appear verbatim in INSTALL_ALLOWLIST (empty = disabled);
 *   - the command is `npm install -g <spec>` via an argv array — no shell, so
 *     a spec can never be interpreted as a command;
 *   - a disk preflight runs first, so a 437 MiB install cannot fill the VPS;
 *   - the route rate-limits to 5/hour and records an audit row per attempt.
 *
 * Uninstall removes the global package and nothing else: user config and
 * session data (`~/.codex`, `~/.qoder`, …) are never touched.
 */

/** The only package manager we drive. Resolved, never taken from input. */
export interface NpmRunner {
  install(spec: string, options: RunOptions): Promise<RunResult>;
  uninstall(pkg: string, options: RunOptions): Promise<RunResult>;
}

export function createNpmRunner(npmPath: string): NpmRunner {
  return {
    install: (spec, options) =>
      runArgv(npmPath, ["install", "-g", spec, "--no-fund", "--no-audit"], options),
    uninstall: (pkg, options) =>
      runArgv(npmPath, ["uninstall", "-g", pkg, "--no-fund", "--no-audit"], options),
  };
}

/** `npm` from the server's own PATH; never from a request. */
export function resolveNpm(
  pathEnv: string = process.env.PATH ?? "",
  isExecutable: (p: string) => boolean = defaultExecutable,
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of ["npm", "npm.cmd"]) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function defaultExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export interface InstallPlan {
  id: ProviderId;
  spec: string;
  /** Why the install cannot run; null when it can. */
  refusal: InstallRefusal | null;
  reason: string | null;
  disk: DiskPlan | null;
}

/**
 * Decide whether an install may run, without running anything. This is what
 * the route calls (and what the card's disabled state is built from) — the
 * UI never has to duplicate the allowlist logic.
 */
export async function planInstall(
  id: ProviderId,
  options: {
    allowlist?: string[];
    npmPath?: string | null;
    freeBytes?: number | null;
    /** npm's global prefix, when the caller has already resolved it. */
    prefixDir?: string;
    /**
     * Lazily resolve the prefix. Called at most once per plan, and only when
     * the plan actually reaches the disk check — a `view` assembling four
     * cards can share one resolver and spawn `npm prefix -g` once instead of
     * four times.
     */
    prefix?: () => Promise<string>;
  } = {},
): Promise<InstallPlan> {
  const spec = integrationSpec(id);
  if (!spec) {
    return { id, spec: "", refusal: "unknown_provider", reason: null, disk: null };
  }
  if (!spec.installSpec || !spec.bin) {
    return {
      id,
      spec: "",
      refusal: "not_installable",
      reason: `${spec.label} needs no install (its binary ships with the app)`,
      disk: null,
    };
  }
  const allowlist = options.allowlist ?? getEnv().INSTALL_ALLOWLIST;
  if (allowlist.length === 0) {
    return {
      id,
      spec: spec.installSpec,
      refusal: "installs_disabled",
      reason:
        "Server-side installs are disabled. Add the package to INSTALL_ALLOWLIST to enable them.",
      disk: null,
    };
  }
  if (!allowlist.includes(spec.installSpec)) {
    return {
      id,
      spec: spec.installSpec,
      refusal: "not_allowlisted",
      reason: `${spec.installSpec} is not in INSTALL_ALLOWLIST`,
      disk: null,
    };
  }

  // `?? resolveNpm()` would turn an explicit "there is no npm" (null) back into
  // a fresh lookup — a caller that has already failed to resolve npm must be
  // able to say so, and the refusal has to be reproducible in tests.
  const npmPath = options.npmPath === undefined ? resolveNpm() : options.npmPath;
  if (!npmPath) {
    return {
      id,
      spec: spec.installSpec,
      refusal: "npm_not_found",
      reason: "npm was not found on this server's PATH",
      disk: null,
    };
  }

  const prefixDir =
    options.prefixDir ??
    (options.prefix
      ? await options.prefix()
      : (await npmGlobalPrefix(npmPath, { fallbackDir: dataDir() })).dir);
  const free =
    options.freeBytes !== undefined ? options.freeBytes : freeBytesAt(prefixDir);
  const disk = planDisk(prefixDir, spec.diskBytes, free);
  return {
    id,
    spec: spec.installSpec,
    refusal: disk.ok ? null : "insufficient_disk",
    reason: disk.reason,
    disk,
  };
}

export interface InstallOutcome {
  ok: boolean;
  id: ProviderId;
  /** Short machine code for the route body and the audit row. */
  code: "installed" | "failed" | "refused";
  detail: string;
  /** Non-secret context recorded in the audit log. */
  audit: Record<string, unknown>;
}

/**
 * Run a planned install. The caller has already rate-limited and decided the
 * request is authorised; this function refuses again on the plan, because a
 * second check costs nothing and a skipped one costs a wrong install.
 */
export async function runInstall(
  id: ProviderId,
  options: {
    runner?: NpmRunner;
    npmPath?: string | null;
    allowlist?: string[];
    freeBytes?: number | null;
    prefixDir?: string;
    timeoutMs?: number;
  } = {},
): Promise<InstallOutcome> {
  const plan = await planInstall(id, options);
  if (plan.refusal) {
    return {
      ok: false,
      id,
      code: "refused",
      detail: plan.reason ?? plan.refusal,
      audit: { refusal: plan.refusal, spec: plan.spec },
    };
  }
  // `?? resolveNpm()` would turn an explicit "there is no npm" (null) back into
  // a fresh lookup — a caller that has already failed to resolve npm must be
  // able to say so, and the refusal has to be reproducible in tests.
  const npmPath = options.npmPath === undefined ? resolveNpm() : options.npmPath;
  const runner = options.runner ?? (npmPath ? createNpmRunner(npmPath) : null);
  if (!runner) {
    return {
      ok: false,
      id,
      code: "refused",
      detail: "npm was not found on this server's PATH",
      audit: { refusal: "npm_not_found" },
    };
  }

  const result = await runner.install(plan.spec, {
    // Global installs are slow on a 2-CPU host; 10 minutes is a ceiling, not
    // an expectation. The route's HTTP request is already answered from the
    // audit row if the browser gives up.
    timeoutMs: options.timeoutMs ?? 10 * 60_000,
    maxOutputBytes: 128 * 1024,
  });

  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    id,
    code: ok ? "installed" : "failed",
    detail: ok
      ? `${plan.spec} installed`
      : result.timedOut
        ? "install timed out"
        : (result.stderr.trim() || `exit ${result.code}`).slice(0, 500),
    audit: {
      spec: plan.spec,
      exitCode: result.code,
      timedOut: result.timedOut,
      diskFreeBytes: plan.disk?.freeBytes ?? null,
    },
  };
}

/** `@scope/name@1.2.3` → `@scope/name` (uninstall takes no version). */
export function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export async function runUninstall(
  id: ProviderId,
  options: { runner?: NpmRunner; npmPath?: string | null; timeoutMs?: number } = {},
): Promise<InstallOutcome> {
  const spec = integrationSpec(id);
  if (!spec) {
    return {
      ok: false,
      id,
      code: "refused",
      detail: "unknown provider",
      audit: { refusal: "unknown_provider" },
    };
  }
  if (!spec.installSpec) {
    return {
      ok: false,
      id,
      code: "refused",
      detail: `${spec.label} is bundled with the app and cannot be uninstalled`,
      audit: { refusal: "not_installable" },
    };
  }
  // `?? resolveNpm()` would turn an explicit "there is no npm" (null) back into
  // a fresh lookup — a caller that has already failed to resolve npm must be
  // able to say so, and the refusal has to be reproducible in tests.
  const npmPath = options.npmPath === undefined ? resolveNpm() : options.npmPath;
  const runner = options.runner ?? (npmPath ? createNpmRunner(npmPath) : null);
  if (!runner) {
    return {
      ok: false,
      id,
      code: "refused",
      detail: "npm was not found on this server's PATH",
      audit: { refusal: "npm_not_found" },
    };
  }

  const pkg = packageNameOf(spec.installSpec);
  const result = await runner.uninstall(pkg, {
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
    maxOutputBytes: 64 * 1024,
  });
  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    id,
    code: ok ? "installed" : "failed",
    detail: ok
      ? `${pkg} removed`
      : result.timedOut
        ? "uninstall timed out"
        : (result.stderr.trim() || `exit ${result.code}`).slice(0, 500),
    audit: { package: pkg, exitCode: result.code, timedOut: result.timedOut },
  };
}
