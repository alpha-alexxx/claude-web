import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectAll,
  detectOne,
  resetDetectionCacheForTest,
  resolveOnPath,
} from "../detect";
import { integrationSpec, parseVersionOutput } from "../registry";
import type { RunResult } from "@/lib/exec/run";

/**
 * Detection is data, never an exception: a missing binary is a status, a
 * failing probe is a reason, and Claude is bundled by construction.
 */

const ok = (stdout: string): RunResult => ({
  code: 0,
  stdout,
  stderr: "",
  timedOut: false,
  truncated: false,
  error: null,
});

let dir: string;
const realExec = (p: string) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "detect-"));
  resetDetectionCacheForTest();
});

describe("parseVersionOutput", () => {
  it("pulls the version out of common CLI formats", () => {
    expect(parseVersionOutput("codex-cli 0.167.0")).toBe("0.167.0");
    expect(parseVersionOutput("opencode 2.2.6\nbuild abc")).toBe("2.2.6");
    expect(parseVersionOutput("v1.1.86")).toBe("1.1.86");
  });

  it("returns null for empty output and a clipped line for prose", () => {
    expect(parseVersionOutput("")).toBeNull();
    expect(parseVersionOutput("unknown command: --version")).toBe(
      "unknown command: --version",
    );
  });
});

describe("resolveOnPath", () => {
  it("returns the first executable file on PATH", () => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, "codex"), "#!/bin/sh\n");
    fs.chmodSync(path.join(b, "codex"), 0o755);
    const found = resolveOnPath("codex", `${a}${path.delimiter}${b}`, realExec);
    expect(found).toBe(path.join(b, "codex"));
  });

  it("skips non-executable and missing entries, and empty PATH segments", () => {
    const a = path.join(dir, "a");
    fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, "codex"), "not exec");
    expect(
      resolveOnPath("codex", `${path.delimiter}${a}${path.delimiter}/nope`, realExec),
    ).toBeNull();
  });
});

describe("detectOne", () => {
  it("reports Claude as bundled without probing anything", async () => {
    const probe = async () => {
      throw new Error("must not probe Claude");
    };
    const d = await detectOne(integrationSpec("claude")!, { probe });
    expect(d.status).toBe("bundled");
    expect(d.path).toBeNull();
  });

  it("reports a missing binary with a reason naming it", async () => {
    const d = await detectOne(integrationSpec("codex")!, {
      pathEnv: dir,
      probe: async () => ok("0.0.0"),
    });
    expect(d.status).toBe("missing");
    expect(d.reason).toContain("codex");
    expect(d.version).toBeNull();
  });

  it("probes --version for an installed binary and parses it", async () => {
    fs.writeFileSync(path.join(dir, "codex"), "");
    fs.chmodSync(path.join(dir, "codex"), 0o755);
    const calls: string[][] = [];
    const d = await detectOne(integrationSpec("codex")!, {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async (_bin, args) => {
        calls.push(args);
        return ok("codex-cli 0.167.0");
      },
    });
    expect(d.status).toBe("installed");
    expect(d.version).toBe("0.167.0");
    expect(calls).toEqual([["--version"]]);
  });

  it("reports installed-with-no-version when the probe prints nothing", async () => {
    fs.writeFileSync(path.join(dir, "qoder"), "");
    fs.chmodSync(path.join(dir, "qoder"), 0o755);
    const d = await detectOne(integrationSpec("qoder")!, {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async () => ok(""),
    });
    expect(d.status).toBe("installed");
    expect(d.version).toBeNull();
    expect(d.reason).toContain("did not print a version");
  });

  it("treats a throwing probe as a detection failure, not an install signal", async () => {
    fs.writeFileSync(path.join(dir, "opencode"), "");
    fs.chmodSync(path.join(dir, "opencode"), 0o755);
    const d = await detectOne(integrationSpec("opencode")!, {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async () => {
        throw new Error("spawn blew up");
      },
    });
    expect(d.status).toBe("broken");
    expect(d.reason).toContain("could not read the version");
  });

  it("does not call a binary that failed to spawn 'installed'", async () => {
    // `runArgv` resolves with `code: null, error: "EACCES"` for a binary that
    // cannot execute. Reporting that as installed lets the enable gate pass,
    // and the first chat message then fails with a spawn error far from the
    // cause the operator was looking at.
    fs.writeFileSync(path.join(dir, "qoder"), "");
    fs.chmodSync(path.join(dir, "qoder"), 0o755);
    const d = await detectOne(integrationSpec("qoder")!, {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        error: "spawn EACCES",
      }),
    });
    expect(d.status).toBe("broken");
    expect(d.reason).toContain("EACCES");
  });

  it("asks the version of a binary that exited non-zero when it printed one", async () => {
    // `codex --version` exiting 1 while still printing "codex-cli 0.167.0" is
    // a real shape; the version is the answer, not the status.
    fs.writeFileSync(path.join(dir, "codex"), "");
    fs.chmodSync(path.join(dir, "codex"), 0o755);
    const d = await detectOne(integrationSpec("codex")!, {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async () => ({ ...ok("codex-cli 0.167.0"), code: 1 }),
    });
    expect(d.status).toBe("installed");
    expect(d.version).toBe("0.167.0");
  });
});

describe("detectAll", () => {
  it("caches for the TTL, re-probing only on refresh", async () => {
    // A real binary on the fixture PATH: with nothing installed every answer
    // is identical, so the probe counter has nothing to count.
    fs.writeFileSync(path.join(dir, "codex"), "");
    fs.chmodSync(path.join(dir, "codex"), 0o755);
    let probes = 0;
    const options = {
      pathEnv: dir,
      isExecutable: realExec,
      probe: async () => {
        probes++;
        return ok("1.0.0");
      },
      now: 1_000,
    };
    const first = await detectAll(options);
    expect(first).toHaveLength(4);
    expect(probes).toBe(1);
    expect(first.find((d) => d.id === "codex")?.checkedAt).toBe(1_000);

    const second = await detectAll({ ...options, now: 2_000 });
    expect(probes).toBe(1); // still inside the 60 s TTL
    expect(second.find((d) => d.id === "codex")?.checkedAt).toBe(1_000);

    // Past the TTL, the cache must expire — this is what the old assertions
    // could not see, because detectOne stamped a real clock the test never read.
    await detectAll({ ...options, now: 1_000 + 61_000 });
    expect(probes).toBe(2);

    await detectAll({ ...options, now: 1_000 + 62_000, refresh: true });
    expect(probes).toBe(3);
  });
});
