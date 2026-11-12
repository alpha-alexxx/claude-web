import "server-only";
import { spawn } from "node:child_process";

/**
 * The one exec seam in the app. Every child process — CLI detection,
 * pinned installs, uninstalls, device-code auth — goes through this function.
 *
 * Security properties, each load-bearing (see the plan's "shelling out is the
 * attack surface" section):
 *
 * 1. No shell, ever. `spawn(bin, argv)` with `shell: false` means a
 *    metacharacter in an argument is a literal byte, not syntax. There is no
 *    string-building path here and there must never be one — no user-supplied
 *    string reaches `sh -c`.
 * 2. Bounded capture. Output is capped at `maxOutputBytes`; a chatty or
 *    hostile child cannot exhaust the server's memory. Truncation is reported
 *    rather than hidden.
 * 3. Hard timeout. A child that ignores SIGTERM is SIGKILLed, so an install
 *    that hangs can never wedge a route handler. On POSIX the child leads its
 *    own process group and the signal goes to the group, because the useful
 *    binaries here are wrappers (`npm` spawns the work) and a grandchild
 *    inheriting our pipe keeps `close` from ever firing. The trade-off is that
 *    the child does not receive the server's own Ctrl-C; every caller here
 *    passes a timeout, which is the bound that matters.
 * 4. Resolves on failure. A missing binary is data (`code: null`, `error`),
 *    not an exception — detection treats "not installed" as a normal answer.
 *
 * `bin` is never user-supplied: callers pass a fixed path or an allowlisted
 * package manager resolved from the registry. This module still refuses
 * non-string argv entries so a malformed call is a programming error, loud.
 */

export interface RunOptions {
  /** Extra variables layered over process.env (never logged by this module). */
  env?: Record<string, string>;
  /** Milliseconds before SIGTERM, then SIGKILL. Default 30 s. */
  timeoutMs?: number;
  /** Per-stream capture cap. Default 256 KiB. */
  maxOutputBytes?: number;
  /** Working directory for the child. */
  cwd?: string;
}

export interface RunResult {
  /** Exit code, or null when the child never started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the timeout killed the child. */
  timedOut: boolean;
  /** True when output hit the capture cap. */
  truncated: boolean;
  /** Spawn-level failure (ENOENT and friends); null on a normal run. */
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/** Accumulates bytes, stopping at the cap but still draining the pipe. */
class BoundedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.size >= this.cap) {
      this.truncated = true;
      return; // keep draining so the child never blocks on a full pipe
    }
    const room = this.cap - this.size;
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (slice.length < chunk.length) this.truncated = true;
    this.chunks.push(slice);
    this.size += slice.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Run `bin` with `argv` and wait for it to finish.
 *
 * Rejects only for programming errors (non-string argv); every runtime
 * outcome — nonzero exit, missing binary, timeout — resolves.
 */
export function runArgv(
  bin: string,
  argv: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (typeof bin !== "string" || bin.length === 0) {
    return Promise.reject(new TypeError("runArgv: bin must be a non-empty string"));
  }
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) {
    return Promise.reject(new TypeError("runArgv: every argv entry must be a string"));
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    const stdout = new BoundedBuffer(cap);
    const stderr = new BoundedBuffer(cap);
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        error,
      });
    };

    let child;
    try {
      child = spawn(bin, argv, {
        shell: false,
        cwd: options.cwd,
        // Inherit the server env (the CLIs need PATH/HOME) and layer the
        // caller's provider-specific variables over it.
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Own process group, so a timeout can signal the whole tree. `npm` is
        // a wrapper: killing only the process we spawned leaves its children
        // holding our stdout pipe, and `close` then waits for a grandchild that
        // was never asked to stop.
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish(null, String(err));
      return;
    }

    // With `detached` the child leads a new group whose id is its pid; without
    // it (Windows) there is no group and only the child itself can be signalled.
    const inGroup = process.platform !== "win32";
    const signal = (sig: NodeJS.Signals): void => {
      if (inGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // The group is already gone (ESRCH) or the child never got one.
        }
      }
      child.kill(sig);
    };

    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (err: Error) => finish(null, err.message));
    child.on("close", (code: number | null) => finish(code, null));

    timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      // SIGTERM is a request, not a guarantee (npm in particular installs
      // handlers). Escalate so a wedged install cannot hold the route open.
      const escalate = setTimeout(() => signal("SIGKILL"), 2_000);
      escalate.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}
