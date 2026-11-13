import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createQoderRunner } from "../qoder/runner";

/**
 * The runner is the only place Qoder is actually spawned, so it is tested
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
  process.stdout.write("Welcome to Qoder\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "qses_1" }) + "\\n");
});
`;

const FAIL_SCRIPT = `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "qses_1" }) + "\\n");
  process.stderr.write("boom: invalid access token\\n");
  process.exit(1);
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-runner-"));
  okBin = path.join(dir, "qoder-ok");
  failBin = path.join(dir, "qoder-fail");
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

describe("qoder runner", () => {
  it("spawns argv-only, writes the prompt to stdin, and yields parsed JSONL", async () => {
    const run = createQoderRunner(() => okBin)(
      ["--print", "--output-format", "stream-json", "--permission-mode", "bypass_permissions"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
        input: "hello prompt",
        kill: () => {},
      },
    );
    const frames = await drain(run.events);

    expect(frames).toEqual([
      {
        type: "argv",
        args: ["--print", "--output-format", "stream-json", "--permission-mode", "bypass_permissions"],
      },
      { type: "stdin", text: "hello prompt" },
      // "Welcome to Qoder" is CLI chatter, not a frame: dropped, not fatal.
      { type: "result", subtype: "success", session_id: "qses_1" },
    ]);
  });

  it("throws with the CLI's stderr tail when the process exits nonzero", async () => {
    const run = createQoderRunner(() => failBin)(["--print"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      input: "hi",
      kill: () => {},
    });
    await expect(drain(run.events)).rejects.toThrow(/invalid access token/);
  });

  it("refuses to spawn when the binary is not on PATH", () => {
    const runner = createQoderRunner(() => null);
    expect(() => runner([], { cwd: dir, env: {}, input: "hi", kill: () => {} })).toThrow(/not installed/);
  });
});
