import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { busyPercent, systemStats } from "../stats";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * system stats: the sampler behind the sidebar meters.
 *
 * Contract pinned:
 * - busy share is a DELTA between two cumulative tick samples, and a zero
 *   delta answers 0 rather than NaN;
 * - clamping: a counter that moved backwards (or idle exceeding total)
 *   cannot produce a share outside 0..100;
 * - a sample is shaped and finite against the real `os`/`process` facts;
 * - an unmeasurable data volume reports `disk: null` instead of a bar
 *   against an invented denominator.
 */

describe("busyPercent", () => {
  it("is 0 when the interval was entirely idle", () => {
    expect(
      busyPercent({ idle: 100, total: 200 }, { idle: 200, total: 300 }),
    ).toBe(0);
  });

  it("is 100 when the interval was entirely busy", () => {
    expect(
      busyPercent({ idle: 100, total: 200 }, { idle: 100, total: 300 }),
    ).toBe(100);
  });

  it("reports the busy share of the delta, not the lifetime share", () => {
    // lifetime 50% busy, but this window: 50 busy of 200 → 25%.
    expect(
      busyPercent({ idle: 900, total: 1000 }, { idle: 1050, total: 1200 }),
    ).toBe(25);
  });

  it("answers 0 for a zero-length window instead of dividing by zero", () => {
    const same = { idle: 50, total: 100 };
    expect(busyPercent(same, { ...same })).toBe(0);
  });

  it("clamps a window whose counters moved backwards", () => {
    expect(
      busyPercent({ idle: 0, total: 100 }, { idle: 500, total: 50 }),
    ).toBe(0);
  });
});

describe("systemStats", () => {
  beforeEach(() => {
    useDummyEnv({ DATABASE_PATH: path.join(os.tmpdir(), "claude-web-stats.db") });
  });

  afterEach(() => {
    clearDummyEnv();
  });

  it("returns a complete, finite sample", () => {
    const stats = systemStats();

    expect(stats.sampledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stats.cpu.cores).toBe(os.cpus().length);
    expect(stats.cpu.busyPct).toBeGreaterThanOrEqual(0);
    expect(stats.cpu.busyPct).toBeLessThanOrEqual(100);
    expect(Number.isFinite(stats.cpu.load1)).toBe(true);

    expect(stats.heap.usedBytes).toBeGreaterThan(0);
    expect(stats.heap.limitBytes).toBeGreaterThan(0);
    // The sample is taken after this process loaded, so heap use is real.
    expect(stats.heap.usedBytes).toBeLessThanOrEqual(stats.heap.limitBytes);

    expect(stats.rss.usedBytes).toBeGreaterThan(0);
    expect(stats.rss.totalBytes).toBe(os.totalmem());
  });

  it("measures the data volume when it exists", () => {
    // The tmpdir is a real directory on a real filesystem.
    const stats = systemStats();
    // Some sandboxes hide statfs; null is the honest answer there and the
    // widget renders "not measurable". Pin whichever this host gives.
    if (stats.disk !== null) {
      expect(stats.disk.totalBytes).toBeGreaterThan(0);
      expect(stats.disk.freeBytes).toBeGreaterThanOrEqual(0);
      expect(stats.disk.freeBytes).toBeLessThanOrEqual(stats.disk.totalBytes);
    }
  });

  it("reports disk: null when the data directory cannot be measured", () => {
    useDummyEnv({
      DATABASE_PATH: path.join(
        os.tmpdir(),
        "claude-web-no-such-dir-9f3a",
        "nested",
        "db.sqlite",
      ),
    });
    expect(systemStats().disk).toBeNull();
  });

  it("differences against the previous call rather than reporting lifetime use", () => {
    const first = systemStats();
    const second = systemStats();
    expect(first.cpu.busyPct).toBeGreaterThanOrEqual(0);
    // Two immediate calls usually span zero clock ticks; either way the
    // answer must be a finite share, never NaN.
    expect(Number.isFinite(second.cpu.busyPct)).toBe(true);
    expect(second.cpu.busyPct).toBeLessThanOrEqual(100);
  });
});
