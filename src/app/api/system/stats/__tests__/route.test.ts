import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * GET /api/system/stats — host facts for the sidebar metres.
 *
 * The contract this route must keep:
 *   - admin-only, and a refusal carries the auth code verbatim so the widget
 *     can tell "never ask again" from "try again later";
 *   - `no-store`: a cached sample is a log of the past;
 *   - rate limited, because the widget polls unattended;
 *   - a refusal does NOT sample — a non-admin must not be able to make the
 *     server do the work by asking anyway.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

const systemStats = vi.fn();
vi.mock("@/lib/system/stats", () => ({
  systemStats: (...args: unknown[]) => systemStats(...args),
}));

import { GET } from "../route";

const ADMIN = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "admin", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const FORBIDDEN = {
  ok: false,
  status: 403,
  code: "forbidden",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const UNAUTHENTICATED = {
  ok: false,
  status: 401,
  code: "unauthenticated",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const SAMPLE = {
  sampledAt: "2026-01-01T00:00:00.000Z",
  cpu: { busyPct: 12.5, load1: 0.42, cores: 2 },
  heap: { usedBytes: 100 * 1024 * 1024, limitBytes: 500 * 1024 * 1024 },
  rss: { usedBytes: 200 * 1024 * 1024, totalBytes: 952 * 1024 * 1024 },
  disk: { freeBytes: 71 * 1024 * 1024 * 1024, totalBytes: 96 * 1024 * 1024 * 1024 },
};

beforeEach(() => {
  useDummyEnv();
  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(ADMIN);
  systemStats.mockReturnValue(SAMPLE);
});

afterEach(() => {
  clearDummyEnv();
  vi.clearAllMocks();
});

describe("GET /api/system/stats", () => {
  it("returns a sample to an admin, uncached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(SAMPLE);
    expect(requireActor).toHaveBeenCalledWith("admin");
  });

  it("refuses a non-admin with 403 and does not sample", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(systemStats).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller with 401", async () => {
    vi.mocked(requireActor).mockResolvedValue(UNAUTHENTICATED);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(systemStats).not.toHaveBeenCalled();
  });

  it("caps a poll loop at 60 reads a minute", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await GET()).status).toBe(200);
    }
    const capped = await GET();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "rate_limited" });
    expect(capped.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(capped.headers.get("cache-control")).toBe("no-store");
    // The capped request never reached the sampler.
    expect(systemStats).toHaveBeenCalledTimes(60);
  });
});
