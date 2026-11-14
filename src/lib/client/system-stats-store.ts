import type { SystemStats } from "@/lib/system/types";
import { getJson } from "./api";

/**
 * system-stats-store: ONE live sample of the host, polled from the sidebar.
 *
 * The shell renders its sidebar twice (desktop column + mobile sheet), so the
 * metre block exists twice in the tree while the sheet is open. Per-instance
 * polling would mean two requests per tick; a module singleton with a
 * refcounted subscription means the first subscriber starts one interval and
 * the last one (when the chat surface unmounts) clears it.
 *
 * It is a `useSyncExternalStore` store, with the same three rules as
 * `conversation-list-store`: stable `getSnapshot` identity, notifications only
 * on a real change, and a PRISTINE `getServerSnapshot` — the live numbers are
 * facts about one server process, and the module is a browser singleton, so
 * returning them here would put them in another visitor's SSR output.
 *
 * Three behaviours beyond the conversation store, all deliberate:
 *   - polling PAUSES while `document.hidden`, so a forgotten tab does not keep
 *     the sampler warm, and resumes with a fresh read on `visibilitychange`;
 *   - a 401/403 (the route is admin-only) STOPS polling for good and records
 *     `denied: true`, so a regular user costs exactly one request per page
 *     load rather than one every five seconds;
 *   - a transient failure keeps the last good sample on screen and marks the
 *     snapshot `failed`, because a blank meter is less true than a stale one.
 *
 * The transport is injectable and the interval is overridable so tests can use
 * fake timers without a network.
 */

export interface SystemStatsSnapshot {
  /** Last successful sample; `null` until the first one lands. */
  stats: SystemStats | null;
  /** The route said 401/403: this viewer may not see host facts. */
  denied: boolean;
  /** The most recent read failed, and `stats` (if any) is stale. */
  failed: boolean;
}

export type SystemStatsRead =
  | { ok: true; stats: SystemStats }
  /** `code` is the server's error code, or `network` / `invalid_response`. */
  | { ok: false; code: string };

export interface SystemStatsTransport {
  read(): Promise<SystemStatsRead>;
}

export interface SystemStatsStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SystemStatsSnapshot;
  getServerSnapshot(): SystemStatsSnapshot;
  /** Read once now. Concurrent calls share one request. */
  refresh(): Promise<void>;
}

export interface SystemStatsStoreOptions {
  /** Poll cadence while the tab is visible. Default 5 s. */
  intervalMs?: number;
}

const INITIAL: SystemStatsSnapshot = Object.freeze({
  stats: null,
  denied: false,
  failed: false,
});

/** Codes that mean "do not ask again": the gate is about who is asking. */
const DENIED_CODES = new Set(["unauthenticated", "forbidden", "account_disabled"]);

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

export function createSystemStatsStore(
  transport: SystemStatsTransport,
  options: SystemStatsStoreOptions = {},
): SystemStatsStore {
  const intervalMs = options.intervalMs ?? 5_000;
  let snapshot: SystemStatsSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let watchingVisibility = false;

  const publish = (next: SystemStatsSnapshot) => {
    // Skip no-op publishes: a failed poll while already failed must not
    // re-render the sidebar every five seconds.
    if (
      next.stats === snapshot.stats &&
      next.denied === snapshot.denied &&
      next.failed === snapshot.failed
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (timer !== null || snapshot.denied || listeners.size === 0) return;
    if (isHidden()) return;
    timer = setInterval(() => {
      void refresh();
    }, intervalMs);
  };

  const refresh = (): Promise<void> => {
    // A denied viewer is settled until reload: the gate is about who is
    // asking, and re-asking on every tick would spend one request per 5 s to
    // hear the same 403. A role change lands on the next page load.
    if (snapshot.denied) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await transport.read();
        if (result.ok) {
          publish({ stats: result.stats, denied: false, failed: false });
          return;
        }
        if (DENIED_CODES.has(result.code)) {
          stopTimer();
          publish({ stats: snapshot.stats, denied: true, failed: false });
          return;
        }
        publish({ stats: snapshot.stats, denied: false, failed: true });
      } catch {
        publish({ stats: snapshot.stats, denied: false, failed: true });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const onVisibilityChange = () => {
    if (isHidden()) {
      stopTimer();
      return;
    }
    // Back in view: one fresh read, then resume the cadence.
    void refresh();
    startTimer();
  };

  const start = () => {
    // A denied viewer is settled: attaching a visibility listener would only
    // create a wake-up that must answer "no" every time.
    if (snapshot.denied) return;
    if (!watchingVisibility && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      watchingVisibility = true;
    }
    if (isHidden()) return;
    void refresh();
    startTimer();
  };

  const stop = () => {
    stopTimer();
    if (watchingVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      watchingVisibility = false;
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    refresh,
  };
}

/**
 * The browser's sample pipe. Resolves — a meter is never worth an unhandled
 * rejection — and carries the server's code so the store can tell "you may
 * not see this" from "the read failed this time".
 */
export async function readSystemStats(
  doFetch: typeof fetch = globalThis.fetch,
): Promise<SystemStatsRead> {
  const result = await getJson("/api/system/stats", doFetch);
  if (!result.ok) return { ok: false, code: result.code };
  if (!isSystemStats(result.body)) return { ok: false, code: "invalid_response" };
  return { ok: true, stats: result.body };
}

/** Shape guard for the wire payload: a partial sample would render lies. */
function isSystemStats(value: unknown): value is SystemStats {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const rec = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === "object";

  const cpu = s.cpu;
  const heap = s.heap;
  const rss = s.rss;
  if (typeof s.sampledAt !== "string") return false;
  if (!rec(cpu) || !num(cpu.busyPct) || !num(cpu.load1) || !num(cpu.cores)) return false;
  if (!rec(heap) || !num(heap.usedBytes) || !num(heap.limitBytes)) return false;
  if (!rec(rss) || !num(rss.usedBytes) || !num(rss.totalBytes)) return false;
  if (s.disk !== null) {
    if (!rec(s.disk) || !num(s.disk.freeBytes) || !num(s.disk.totalBytes)) return false;
  }
  return true;
}

/** The app's single poller. One per browser tab, created on first import. */
export const systemStatsStore = createSystemStatsStore({
  read: () => readSystemStats(),
});
