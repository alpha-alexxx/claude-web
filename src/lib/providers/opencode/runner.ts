import { spawn } from "node:child_process";
import readline from "node:readline";
import type { OpenCodeRun, OpenCodeRunner } from "./session";

/**
 * The production `OpenCodeRunner`: spawn `opencode` with argv only (never a
 * shell), write the prompt to stdin, and stream stdout's NDJSON frames.
 *
 * Kept module-private to the adapter directory and reached only through
 * `OpenCodeRunner`, so every higher layer stays testable without a CLI.
 *
 * Same reasoning as the Codex runner: the vendor's own integration surface
 * bundles its CLI and controls the child env, which fights this app's rules
 * (one install surface, detection-driven PATH lookup, host-env inheritance).
 * The NDJSON contract is small, and it is three constructs: spawn, stdin,
 * readline.
 */

/** Resolve the binary at run time, never at module load (tests replace PATH). */
export type BinaryLocator = () => string | null;

/**
 * Bounded stderr capture. OpenCode reports fatal errors there and a broken
 * install can emit megabytes of it; the message a user sees keeps the tail,
 * where the actual cause is.
 */
const MAX_STDERR_CHARS = 8_000;

export function createOpenCodeRunner(locate: BinaryLocator): OpenCodeRunner {
  return (argv, opts): OpenCodeRun => {
    const bin = locate();
    if (!bin) throw new Error("opencode is not installed on this server");

    // argv-only: `shell: false` means a prompt's metacharacters are bytes in
    // an argument, never syntax. The prompt itself goes over stdin.
    // The tuple must be MUTABLE and literal-typed: `spawn` only returns a
    // typed ChildProcess for SpawnOptionsWithStdioTuple, and a widened
    // `string[]` matches no overload — TypeScript then resolves the call to
    // `never` and every `child.stdin` below becomes a type error.
    const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
    const child = spawn(bin, argv, {
      cwd: opts.cwd,
      // Next augments NodeJS.ProcessEnv with a REQUIRED readonly NODE_ENV, so
      // a plain Record<string,string> is not assignable even though it is the
      // exact runtime shape. Merged host env in practice carries it anyway.
      env: opts.env as NodeJS.ProcessEnv,
      shell: false,
      stdio,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    // A spawn failure (ENOENT between detection and run, EACCES) surfaces as
    // an 'error' event; record it so the exit code path can report it.
    let spawnError: string | null = null;
    child.on("error", (err) => {
      spawnError = err.message;
    });

    // stdin is ignored if the child is already gone; EPIPE must not crash the
    // server (the turn fails through the exit code instead).
    child.stdin?.on("error", () => {});
    child.stdin?.write(opts.input);
    child.stdin?.end();

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );

    let killed = false;

    const events = (async function* (): AsyncGenerator<unknown> {
      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            yield JSON.parse(trimmed) as unknown;
          } catch {
            // A non-JSON line is CLI chatter (banners, warnings), not a frame.
            // Dropping it keeps a stray print on stdout from killing a turn.
          }
        }
      } finally {
        rl.close();
      }

      const { code, signal } = await exited;
      // A run WE killed is not a failure: the session that killed it already
      // emitted the authoritative turn_end (Stop, timeout, close), and a
      // second error frame after it would be noise the user cannot act on.
      if (killed) return;
      // `opencode run` exits 1 after writing its own `error` frame; the
      // session has already turned that into a turn_end by the time this
      // throws, and its once-guard drops the duplicate.
      if (code !== 0) {
        const detail = stderr.trim() || spawnError || signal || "no output";
        throw new Error(`opencode exited ${code ?? `on ${signal ?? "a signal"}`}: ${detail}`);
      }
    })();

    const kill = (): void => {
      killed = true;
      // Signal the whole group when we made one: `opencode` is a wrapper that
      // spawns the real worker, and killing only the wrapper leaves the
      // worker writing to a pipe nobody reads.
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
          return;
        } catch {
          // group already gone; fall through to the direct kill
        }
      }
      child.kill("SIGTERM");
    };

    return { events, kill };
  };
}
