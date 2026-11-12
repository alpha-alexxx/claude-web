import "server-only";
import fs from "node:fs";
import path from "node:path";
import { runArgv, type RunResult } from "@/lib/exec/run";
import { INTEGRATIONS, parseVersionOutput, type IntegrationSpec } from "./registry";
import type { ProviderId } from "@/lib/providers/types";
import type { DetectStatus } from "./types";

/** Re-exported: detection state is also the card vocabulary. */
export type { DetectStatus };

/**
 * CLI detection: is the binary on PATH, and what does it say its version is?
 *
 * Every answer here is data, not an exception — "not installed" is the normal
 * state of three of the four providers, and the Integrations page renders it
 * as a fact rather than an error. The version probe runs the binary itself, so
 * a stale shim that prints nothing is reported as "installed, version unknown"
 * instead of a guessed version.
 *
 * Results are cached briefly because the page refreshes on every focus: a
 * `--version` spawn per card per focus would be a small process storm.
 */

export interface Detection {
  id: ProviderId;
  status: DetectStatus;
  /** Resolved absolute path on PATH, when found. */
  path: string | null;
  /** Parsed version, or null when the binary could not be asked. */
  version: string | null;
  /** Why detection is not a clean "yes", for the card to show verbatim. */
  reason: string | null;
  checkedAt: number;
}

/**
 * Resolve an executable name against PATH without shelling out to `which`.
 * Returns the first executable regular file, or null.
 */
export function resolveOnPath(
  bin: string,
  pathEnv: string = process.env.PATH ?? "",
  isExecutable: (p: string) => boolean = defaultIsExecutable,
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function defaultIsExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Injectable probe so tests never spawn a real CLI. */
export type VersionProbe = (bin: string, args: string[]) => Promise<RunResult>;

const defaultProbe: VersionProbe = (bin, args) =>
  runArgv(bin, args, { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 });

export interface DetectOptions {
  pathEnv?: string;
  isExecutable?: (p: string) => boolean;
  probe?: VersionProbe;
  /** Injectable clock so cache TTLs are testable. Defaults to `Date.now`. */
  now?: number;
}

/** Detect one provider. Claude is bundled, so it is never probed. */
export async function detectOne(
  spec: IntegrationSpec,
  options: DetectOptions = {},
): Promise<Detection> {
  const now = options.now ?? Date.now();
  if (spec.bin === null) {
    return {
      id: spec.id,
      status: "bundled",
      path: null,
      version: null,
      reason: null,
      checkedAt: now,
    };
  }

  const resolved = resolveOnPath(
    spec.bin,
    options.pathEnv ?? process.env.PATH ?? "",
    options.isExecutable ?? defaultIsExecutable,
  );
  if (!resolved) {
    return {
      id: spec.id,
      status: "missing",
      path: null,
      version: null,
      reason: `${spec.bin} is not on this server's PATH`,
      checkedAt: now,
    };
  }

  const probe = options.probe ?? defaultProbe;
  let result: RunResult;
  try {
    result = await probe(resolved, spec.versionArgs);
  } catch (err) {
    // A probe that throws is a detection failure, never an install signal.
    return {
      id: spec.id,
      status: "broken",
      path: resolved,
      version: null,
      reason: `could not read the version: ${String(err).slice(0, 120)}`,
      checkedAt: now,
    };
  }

  // A spawn-level failure (EACCES, bad interpreter, wrong arch) still has an
  // executable bit set, so `resolveOnPath` found it — but it cannot run. That
  // is "broken", not "installed": the enable gate must refuse it, or the first
  // chat message fails with a spawn error far from the cause the operator saw.
  if (result.error !== null) {
    return {
      id: spec.id,
      status: "broken",
      path: resolved,
      version: null,
      reason: `found at ${resolved} but it will not run: ${result.error.slice(0, 120)}`,
      checkedAt: now,
    };
  }

  // A killed probe (timeout, or code null with no spawn error) told us nothing
  // about the version either way; the binary exists and started.
  if (result.timedOut) {
    return {
      id: spec.id,
      status: "installed",
      path: resolved,
      version: null,
      reason: "installed, but it did not answer the version probe in time",
      checkedAt: now,
    };
  }

  const version = parseVersionOutput(result.stdout || result.stderr || "");
  return {
    id: spec.id,
    status: "installed",
    path: resolved,
    version,
    reason: version ? null : "installed, but it did not print a version",
    checkedAt: now,
  };
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<ProviderId, Detection>();

/**
 * Detect every provider, reusing answers younger than the TTL. `refresh`
 * forces a fresh probe (the card's "Check again" action).
 */
export async function detectAll(
  options: DetectOptions & { refresh?: boolean; now?: number } = {},
): Promise<Detection[]> {
  const now = options.now ?? Date.now();
  const out: Detection[] = [];
  for (const spec of INTEGRATIONS) {
    const hit = cache.get(spec.id);
    if (!options.refresh && hit && now - hit.checkedAt < CACHE_TTL_MS) {
      out.push(hit);
      continue;
    }
    const detection = await detectOne(spec, { ...options, now });
    cache.set(spec.id, detection);
    out.push(detection);
  }
  return out;
}

/**
 * Drop a cached detection after something changed the binary on disk (an
 * install or uninstall just ran). Without this the page would keep showing a
 * 60-second-old "not installed" for an action the user just watched succeed.
 */
export function invalidateDetection(id?: ProviderId): void {
  if (id) cache.delete(id);
  else cache.clear();
}

/** Test seam. */
export function resetDetectionCacheForTest(): void {
  cache.clear();
}
