import "server-only";
import fs from "node:fs";
import path from "node:path";
import { runArgv, type RunOptions, type RunResult } from "@/lib/exec/run";

/**
 * Disk preflight for pinned CLI installs.
 *
 * Codex is ~437 MiB unpacked and OpenCode ~204 MB; installing either onto a
 * nearly full volume is the failure mode that takes the whole app down (SQLite
 * gets no room to write). So the plan is computed BEFORE the install runs and
 * refused when it would leave less than a reserve.
 *
 * The measurement is taken on npm's global prefix, because that is where the
 * bytes land — not on the cwd, which is usually a different filesystem.
 */

/** Keep at least this much free after an install. */
export const DISK_RESERVE_BYTES = 512 * 1024 * 1024;

export interface DiskPlan {
  /** Directory measured: npm's global prefix. */
  dir: string;
  freeBytes: number;
  /** Bytes this install needs, including the reserve. */
  requiredBytes: number;
  ok: boolean;
  /** Why it is not ok; null when it is. */
  reason: string | null;
}

/** npm's global prefix (`npm prefix -g`), or a fallback when npm cannot say. */
export async function npmGlobalPrefix(
  npmPath: string,
  options: {
    timeoutMs?: number;
    /**
     * Directory to measure when npm cannot report its prefix. Callers pass the
     * data directory: the database this app must not starve lives there, and
     * unlike `process.cwd()` it is the same place on every launch.
     */
    fallbackDir?: string;
    run?: (bin: string, argv: string[], opts: RunOptions) => Promise<RunResult>;
  } = {},
): Promise<{ dir: string; resolved: boolean }> {
  const run = options.run ?? runArgv;
  const result = await run(npmPath, ["prefix", "-g"], {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: 4 * 1024,
  });
  const dir = result.stdout.trim().split(/\r?\n/)[0]?.trim();
  if (result.code === 0 && dir && path.isAbsolute(dir)) {
    return { dir, resolved: true };
  }
  // Unknown prefix: measure the fallback's filesystem, which at least shares
  // the volume with the database this install must not starve.
  return { dir: options.fallbackDir ?? process.cwd(), resolved: false };
}

export function freeBytesAt(dir: string): number | null {
  try {
    // statfs is available on node:fs across platforms; the type permits an
    // options object but the plain call is the portable form.
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/**
 * Decide whether `diskBytes` can be installed at `dir`.
 *
 * An unmeasurable filesystem (statfs throws) is treated as OK with a reason
 * recorded: refusing every install because a container hides the numbers would
 * make the feature unusable, and the install itself would still fail loudly.
 */
export function planDisk(
  dir: string,
  diskBytes: number,
  freeBytes: number | null,
): DiskPlan {
  const requiredBytes = diskBytes + DISK_RESERVE_BYTES;
  if (freeBytes === null) {
    return {
      dir,
      freeBytes: 0,
      requiredBytes,
      ok: true,
      reason: "free space could not be measured on this filesystem",
    };
  }
  const ok = freeBytes >= requiredBytes;
  return {
    dir,
    freeBytes,
    requiredBytes,
    ok,
    reason: ok
      ? null
      : `needs ${formatMiB(requiredBytes)} free at ${dir}; ${formatMiB(freeBytes)} available`,
  };
}

export function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}
