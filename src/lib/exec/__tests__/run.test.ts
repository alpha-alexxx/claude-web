import { describe, it, expect } from "vitest";
import { runArgv } from "../run";

/**
 * The exec seam. These tests pin the three properties the plan's security
 * section depends on: no shell (a metacharacter is inert), bounded output, and
 * a hard timeout that actually kills the child.
 *
 * The child under test is always `process.execPath` — never a string assembled
 * from user input, and never a shell.
 */

const node = process.execPath;

describe("runArgv", () => {
  it("runs a binary with an argv array and captures stdout", async () => {
    const result = await runArgv(node, ["-e", "process.stdout.write('hello')"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and the exit code separately", async () => {
    const result = await runArgv(node, [
      "-e",
      "process.stderr.write('bad'); process.exit(3)",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("bad");
  });

  it("treats shell metacharacters as literal argv (never a shell)", async () => {
    // If this ever went through `sh -c`, the child would print "pwned" and
    // the second argument would vanish. spawn without a shell passes both
    // strings through untouched.
    const result = await runArgv(node, [
      "-e",
      "process.stdout.write(process.argv.slice(1).join('|'))",
      "; echo pwned",
      "$(echo pwned)",
    ]);
    expect(result.stdout).toBe("; echo pwned|$(echo pwned)");
    expect(result.stdout).not.toContain("pwned\n");
  });

  it("caps captured output instead of buffering an unbounded stream", async () => {
    const result = await runArgv(
      node,
      ["-e", "process.stdout.write('x'.repeat(200000))"],
      { maxOutputBytes: 1024 },
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024);
  });

  it("kills a child that outlives the timeout", async () => {
    const started = Date.now();
    const result = await runArgv(
      node,
      ["-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 250 },
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("kills grandchildren that hold the pipes after the direct child exits", async () => {
    // `npm install -g` is the real case: npm exits or is killed, and a child it
    // spawned keeps stdout open. The `close` event waits for every fd on the
    // pipe, so killing only the direct child leaves this promise pending until
    // the grandchild feels like stopping — a route handler wedged for minutes.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });",
      "g.unref();",
      "process.exit(0);",
    ].join("\n");
    const started = Date.now();
    const result = await runArgv(node, ["-e", script], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("resolves rather than rejects when the binary does not exist", async () => {
    const result = await runArgv("/nonexistent/binary-nope", ["--version"]);
    expect(result.code).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("rejects an argv entry that is not a string", async () => {
    await expect(
      runArgv(node, ["-e", 42 as unknown as string]),
    ).rejects.toThrow(/argv/);
  });

  it("passes only the extra env it was given, on top of the process env", async () => {
    const result = await runArgv(
      node,
      ["-e", "process.stdout.write(String(process.env.CW_TEST_TOKEN))"],
      { env: { CW_TEST_TOKEN: "abc123" } },
    );
    expect(result.stdout).toBe("abc123");
  });
});
