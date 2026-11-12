import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  DISK_RESERVE_BYTES,
  formatMiB,
  freeBytesAt,
  npmGlobalPrefix,
  planDisk,
} from "../disk";
import type { RunResult } from "@/lib/exec/run";

/**
 * The preflight is the only thing standing between a 437 MiB install and a
 * full volume (which would also stop SQLite from writing). These tests pin
 * the reserve, the failure message, and the two fallbacks: an unmeasurable
 * filesystem is allowed through with a reason, and an npm that cannot report
 * its prefix still yields a directory to measure.
 */

const result = (over: Partial<RunResult>): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  error: null,
  ...over,
});

const MiB = 1024 * 1024;

describe("planDisk", () => {
  it("allows an install with room for the package plus the reserve", () => {
    const plan = planDisk("/g", 100 * MiB, 1000 * MiB);
    expect(plan.ok).toBe(true);
    expect(plan.reason).toBeNull();
    expect(plan.requiredBytes).toBe(100 * MiB + DISK_RESERVE_BYTES);
  });

  it("refuses at exactly one byte short, and names both numbers", () => {
    const need = 100 * MiB + DISK_RESERVE_BYTES;
    expect(planDisk("/g", 100 * MiB, need).ok).toBe(true);
    const short = planDisk("/g", 100 * MiB, need - 1);
    expect(short.ok).toBe(false);
    expect(short.reason).toContain("/g");
    expect(short.reason).toContain("available");
  });

  it("treats an unmeasurable filesystem as ok, with a reason recorded", () => {
    const plan = planDisk("/g", 437 * MiB, null);
    expect(plan.ok).toBe(true);
    expect(plan.reason).toContain("could not be measured");
  });
});

describe("formatMiB", () => {
  it("switches to GiB at 1024 MiB", () => {
    expect(formatMiB(512 * MiB)).toBe("512 MiB");
    expect(formatMiB(1024 * MiB)).toBe("1.0 GiB");
    expect(formatMiB(1.5 * 1024 * MiB)).toBe("1.5 GiB");
  });
});

describe("npmGlobalPrefix", () => {
  it("returns npm's reported prefix, first line only", async () => {
    const calls: string[][] = [];
    const p = await npmGlobalPrefix("/usr/bin/npm", {
      run: async (_bin, argv) => {
        calls.push(argv);
        return result({ stdout: "/usr/local/lib/node_modules\nnoise\n" });
      },
    });
    expect(p).toEqual({ dir: "/usr/local/lib/node_modules", resolved: true });
    expect(calls).toEqual([["prefix", "-g"]]);
  });

  it("falls back to the cwd when npm fails or reports a relative path", async () => {
    const failed = await npmGlobalPrefix("/usr/bin/npm", {
      run: async () => result({ code: 1 }),
    });
    expect(failed).toEqual({ dir: process.cwd(), resolved: false });

    const relative = await npmGlobalPrefix("/usr/bin/npm", {
      run: async () => result({ stdout: "node_modules\n" }),
    });
    expect(relative).toEqual({ dir: process.cwd(), resolved: false });
  });

  it("measures the caller's fallback instead of the process cwd", async () => {
    // `process.cwd()` is wherever the server happened to be launched — often a
    // different volume from the database. A caller that knows its data
    // directory passes it, and that is what gets measured.
    const p = await npmGlobalPrefix("/usr/bin/npm", {
      fallbackDir: "/srv/claude-web/data",
      run: async () => result({ code: 1 }),
    });
    expect(p).toEqual({ dir: "/srv/claude-web/data", resolved: false });
  });

  it("falls back when the binary cannot even be spawned", async () => {
    const p = await npmGlobalPrefix("/nope/npm", {
      run: async () => result({ code: null, error: "ENOENT" }),
    });
    expect(p.resolved).toBe(false);
    expect(path.isAbsolute(p.dir)).toBe(true);
  });
});

describe("freeBytesAt", () => {
  it("measures a real directory and returns null for a missing one", () => {
    const free = freeBytesAt(process.cwd());
    expect(free).not.toBeNull();
    expect(free!).toBeGreaterThan(0);
    expect(freeBytesAt("/definitely/not/here")).toBeNull();
  });
});
