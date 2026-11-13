import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenCodeRunner } from "../opencode/runner";

/**
 * The runner is the only place OpenCode is actually spawned, so it is tested
 * against a REAL child process — a tiny node script standing in for the CLI.
 * That proves the parts a mock cannot: stdin delivery, NDJSON line splitting,
 * stderr capture on failure, and argv passing without a shell.
 */

let dir: string;
let okBin: string;
let failBin: string;

const OK_SCRIPT = `#!${process.execPath}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "argv", args: process.argv.slice(2) }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "stdin", text: stdin }) + "\\n");
  process.stdout.write("not json\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", sessionID: "ses_1" }) + "\\n");
});
`;

const FAIL_SCRIPT = `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "error", sessionID: "ses_1" }) + "\\n");
  process.stderr.write("boom: no provider configured\\n");
  process.exit(1);
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runner-"));
  okBin = path.join(dir, "opencode-ok");
  failBin = path.join(dir, "opencode-fail");
  fs.writeFileSync(okBin, OK_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(failBin, FAIL_SCRIPT, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function drain(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("opencode runner", () => {
  it("spawns argv-only, writes the prompt to stdin, and yields parsed NDJSON", async () => {
    const run = createOpenCodeRunner(() => okBin)(
      ["run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-4"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
        input: "hello prompt",
        kill: () => {},
      },
    );
    const frames = await drain(run.events);

    expect(frames).toEqual([
      { type: "argv", args: ["run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-4"] },
      { type: "stdin", text: "hello prompt" },
      { type: "step_finish", sessionID: "ses_1" },
    ]);
  });

  it("throws with the CLI's stderr when the process exits nonzero", async () => {
    const run = createOpenCodeRunner(() => failBin)(["run"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      input: "hi",
      kill: () => {},
    });
    const frames: unknown[] = [];
    await expect(
      (async () => {
        for await (const f of run.events) frames.push(f);
      })(),
    ).rejects.toThrow(/boom: no provider configured/);
    // Frames before the failure are still delivered — a failed turn keeps
    // whatever it managed to say.
    expect(frames).toEqual([{ type: "error", sessionID: "ses_1" }]);
  });

  it("throws a clear error when the binary is missing", () => {
    const runner = createOpenCodeRunner(() => null);
    expect(() => runner(["run"], { cwd: dir, env: {}, input: "", kill: () => {} })).toThrow(
      /not installed/,
    );
  });

  it("kill() terminates a hung process", async () => {
    const hang = path.join(dir, "opencode-hang");
    fs.writeFileSync(
      hang,
      `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("data", () => {});\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const runner = createOpenCodeRunner(() => hang);
    const run = runner(["run"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      input: "hi",
      kill: () => {},
    });
    const drained = drain(run.events);
    // Give the process a moment to start before killing it.
    await new Promise((r) => setTimeout(r, 150));
    run.kill();
    await expect(drained).resolves.toEqual([]);
  });
});
