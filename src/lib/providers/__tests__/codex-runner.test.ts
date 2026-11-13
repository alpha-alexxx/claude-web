import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexRunner } from "../codex/runner";

/**
 * The runner is the only place Codex is actually spawned, so it is tested
 * against a REAL child process — a tiny node script standing in for the CLI.
 * That proves the parts a mock cannot: stdin delivery, JSONL line splitting,
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
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
});
`;

const FAIL_SCRIPT = `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t" }) + "\\n");
  process.stderr.write("boom: model unavailable\\n");
  process.exit(3);
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-"));
  okBin = path.join(dir, "codex-ok");
  failBin = path.join(dir, "codex-fail");
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

describe("codex runner", () => {
  it("spawns argv-only, writes the prompt to stdin, and yields parsed JSONL", async () => {
    const run = createCodexRunner(() => okBin)(["exec", "--experimental-json", "--model", "gpt-5"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: os.homedir() },
      input: "hello prompt",
      kill: () => {},
    });
    const frames = await drain(run.events);

    expect(frames).toEqual([
      { type: "argv", args: ["exec", "--experimental-json", "--model", "gpt-5"] },
      { type: "stdin", text: "hello prompt" },
      { type: "turn.completed", usage: {} },
    ]);
  });

  it("throws with the CLI's stderr when the process exits nonzero", async () => {
    const run = createCodexRunner(() => failBin)(["exec"], {
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
    ).rejects.toThrow(/boom: model unavailable/);
    // Frames before the failure are still delivered — a failed turn keeps
    // whatever it managed to say.
    expect(frames).toEqual([{ type: "thread.started", thread_id: "t" }]);
  });

  it("throws a clear error when the binary is missing", () => {
    const runner = createCodexRunner(() => null);
    expect(() =>
      runner(["exec"], { cwd: dir, env: {}, input: "", kill: () => {} }),
    ).toThrow(/not installed/);
  });

  it("kill() terminates a hung process", async () => {
    const hang = path.join(dir, "codex-hang");
    fs.writeFileSync(
      hang,
      `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on("data", () => {});\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const runner = createCodexRunner(() => hang);
    const run = runner(["exec"], {
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
