import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSystemStatsStore,
  type SystemStatsRead,
  type SystemStatsTransport,
} from "./system-stats-store";
import type { SystemStats } from "@/lib/system/types";

/**
 * system-stats-store: the ONE poller behind the sidebar metres.
 *
 * Contract pinned:
 * - the server snapshot is pristine: these are one server's facts, and the
 *   module is a browser singleton, so they must never ride in SSR output;
 * - two subscribers (desktop column + mobile sheet) share one interval;
 * - polling pauses while the tab is hidden and resumes with a fresh read;
 * - a 401/403 stops polling for good — a regular user pays one request, not
 *   one every five seconds;
 * - a transient failure keeps the last good sample and marks it stale;
 * - overlapping refreshes share one request.
 */

const SAMPLE: SystemStats = {
  sampledAt: "2026-01-01T00:00:00.000Z",
  cpu: { busyPct: 12.5, load1: 0.4, cores: 2 },
  heap: { usedBytes: 100, limitBytes: 500 },
  rss: { usedBytes: 200, totalBytes: 950 },
  disk: { freeBytes: 1000, totalBytes: 4000 },
};

const OK: SystemStatsRead = { ok: true, stats: SAMPLE };

function fakeTransport(
  read: () => Promise<SystemStatsRead> = async () => OK,
): SystemStatsTransport & { read: ReturnType<typeof vi.fn> } {
  const transport = { read: vi.fn(read) };
  return transport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A minimal `document` so hidden/visibility handling is testable in node. */
function installDocument(hidden = false) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      if (type === "visibilitychange") listeners.delete(fn);
    }),
  };
  vi.stubGlobal("document", doc);
  return {
    doc,
    setHidden(next: boolean) {
      doc.hidden = next;
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createSystemStatsStore", () => {
  it("starts pristine and serves the same pristine state to the server render", () => {
    const store = createSystemStatsStore(fakeTransport(), { intervalMs: 1000 });
    expect(store.getSnapshot()).toEqual({ stats: null, denied: false, failed: false });
    expect(store.getServerSnapshot()).toEqual({ stats: null, denied: false, failed: false });
  });

  it("ignores the live snapshot for server renders even after a sample lands", async () => {
    // This is the SSR leak the pristine server snapshot prevents: the
    // singleton's live numbers belong to whoever is looking at THIS tab.
    const store = createSystemStatsStore(fakeTransport(), { intervalMs: 1000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().stats).toEqual(SAMPLE);
    expect(store.getServerSnapshot()).toEqual({ stats: null, denied: false, failed: false });
    unsubscribe();
  });

  it("reads once on the first subscriber and polls on the interval", async () => {
    const transport = fakeTransport();
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.read).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.read).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("shares one interval between two subscribers and stops on the last", async () => {
    const transport = fakeTransport();
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.read).toHaveBeenCalledTimes(2);

    a();
    await vi.advanceTimersByTimeAsync(5000);
    // Still one subscriber → still polling.
    expect(transport.read).toHaveBeenCalledTimes(3);

    b();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.read).toHaveBeenCalledTimes(3);
  });

  it("notifies subscribers only when the snapshot actually changes", async () => {
    const transport = fakeTransport();
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);

    // Identical data: the store must keep the same object identity, or every
    // poll re-renders both sidebars for nothing.
    const before = store.getSnapshot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("pauses while hidden and reads once on return", async () => {
    const fake = installDocument(false);
    const transport = fakeTransport();
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledTimes(1);

    fake.setHidden(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.read).toHaveBeenCalledTimes(1);

    fake.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.read).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(fake.listenerCount()).toBe(0);
  });

  it("does not poll at all while the document starts hidden", async () => {
    const fake = installDocument(true);
    const transport = fakeTransport();
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.read).not.toHaveBeenCalled();

    fake.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("stops for good on 403 and records denied", async () => {
    const transport = fakeTransport(async () => ({ ok: false, code: "forbidden" }));
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getSnapshot()).toEqual({ stats: null, denied: true, failed: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.read).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("treats 401 the same as 403", async () => {
    const transport = fakeTransport(async () => ({ ok: false, code: "unauthenticated" }));
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().denied).toBe(true);
    expect(transport.read).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the last good sample on a transient failure and flags it", async () => {
    const read = vi
      .fn<() => Promise<SystemStatsRead>>()
      .mockResolvedValueOnce(OK)
      .mockResolvedValue({ ok: false, code: "network" });
    const store = createSystemStatsStore({ read }, { intervalMs: 5000 });
    const unsubscribe = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().stats).toEqual(SAMPLE);

    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot()).toEqual({ stats: SAMPLE, denied: false, failed: true });

    // And it recovers on the next good read.
    read.mockResolvedValue(OK);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getSnapshot()).toEqual({ stats: SAMPLE, denied: false, failed: false });
    unsubscribe();
  });

  it("shares one in-flight request between overlapping refreshes", async () => {
    const pending = deferred<SystemStatsRead>();
    const transport = fakeTransport(() => pending.promise);
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });

    const first = store.refresh();
    const second = store.refresh();
    expect(transport.read).toHaveBeenCalledTimes(1);
    pending.resolve(OK);
    await Promise.all([first, second]);
    expect(transport.read).toHaveBeenCalledTimes(1);
  });

  it("resolves — never rejects — when the transport throws", async () => {
    const transport = fakeTransport(async () => {
      throw new Error("offline");
    });
    const store = createSystemStatsStore(transport, { intervalMs: 5000 });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.getSnapshot().failed).toBe(true);
  });
});
