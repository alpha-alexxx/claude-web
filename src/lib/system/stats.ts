import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { getEnv } from "@/lib/env";
import { freeBytesAt } from "@/lib/integrations/disk";
import type { SystemStats } from "./types";

/**
 * One snapshot of the host facts the sidebar meters show: CPU busy share,
 * process heap vs its V8 limit, RSS vs machine RAM, and the data volume.
 *
 * Everything here comes from `node:os` / `process` / `v8` — no shelling out, no
 * `/proc` parsing, and no PTY. That keeps the numbers cheap enough to poll
 * every few seconds and portable across the hosts this app runs on.
 *
 * CPU is the only stateful part. `os.cpus()` reports cumulative tick counters,
 * so a share has to be a delta between two reads. The previous sample is
 * module-scope: one process, one operator, and concurrent pollers sharing one
 * window is exactly right. The first call after boot has no baseline and
 * reports the share since this module was loaded (~0), not a fabricated 100%.
 */
interface CpuTicks {
  idle: number;
  total: number;
}

function cpuTicks(): CpuTicks {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let previous: CpuTicks | null = null;

/**
 * Busy share between two cumulative samples, 0..100. A zero delta (two reads
 * inside the same clock tick) has no answer — report 0 rather than NaN.
 */
export function busyPercent(prev: CpuTicks, next: CpuTicks): number {
  const total = next.total - prev.total;
  if (total <= 0) return 0;
  const idle = next.idle - prev.idle;
  const busy = Math.min(Math.max(total - idle, 0), total);
  return Math.round((busy / total) * 1000) / 10;
}

/** The volume the database lives on — the one the app must not starve. */
function dataDir(): string {
  return path.dirname(getEnv().DATABASE_PATH);
}

function diskUsage(): SystemStats["disk"] {
  const dir = dataDir();
  const free = freeBytesAt(dir);
  if (free === null) return null;
  let total: number;
  try {
    const stats = fs.statfsSync(dir);
    total = Number(stats.blocks) * Number(stats.bsize);
  } catch {
    return null;
  }
  // A filesystem that cannot say how big it is cannot be a ratio; the free
  // number alone would render a bar against an invented denominator.
  if (!Number.isFinite(total) || total <= 0) return null;
  return { freeBytes: free, totalBytes: total };
}

export function systemStats(): SystemStats {
  const next = cpuTicks();
  const busyPct = previous ? busyPercent(previous, next) : 0;
  previous = next;

  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;

  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      busyPct,
      load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
      cores: os.cpus().length,
    },
    heap: { usedBytes: mem.heapUsed, limitBytes: heapLimit },
    rss: { usedBytes: mem.rss, totalBytes: os.totalmem() },
    disk: diskUsage(),
  };
}
