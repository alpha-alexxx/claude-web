/**
 * In-memory sliding-window rate limiter. Single-process (this app is a
 * single Node server), no persistence — restart clears the windows, which is
 * acceptable: limits here protect against hammering, not bookkeeping.
 */

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface RateLimitKey {
  bucket: string;
  id: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest entry leaves the window (for Retry-After). */
  retryAfterSec: number;
  remaining: number;
}

export const RATE_LIMITS = {
  /**
   * 30 Integrations reads / min per admin. The page refetches on focus, and a
   * `?refresh=1` read spawns a `--version` probe per CLI plus `npm prefix -g`,
   * so an unattended tab must not be able to build a process storm.
   */
  integrations: { max: 30, windowMs: 60_000 },
  /** 10 chat turns / min per user */
  turn: { max: 10, windowMs: 60_000 },
  /** 5 CLI installs / hour per user */
  install: { max: 5, windowMs: 60 * 60_000 },
  /**
   * 60 render-token mints / min per user. Higher than the Integrations bucket
   * because a transcript with many images mints one token per image, but still
   * bounded: every mint is a filesystem sniff or an outbound fetch.
   */
  render: { max: 60, windowMs: 60_000 },
  /**
   * 180 render-token redemptions / min per user.
   *
   * Minting alone is not the bound that matters. A token lives for five
   * minutes and can be redeemed any number of times inside that window, so 60
   * mints/min would allow ~300 live tokens each fetched without limit — an
   * unmetered outbound-fetch primitive whose rate is set by whoever holds a
   * token. One redemption per mint is the normal case (a transcript with N
   * images mints and reads N), with headroom for a re-render or a retry.
   */
  renderRead: { max: 180, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitConfig>;

const windows = new Map<string, number[]>();

/**
 * Sweep cadence. Entries are pruned when their own key is touched, but a key
 * that is never touched again would otherwise live for the process lifetime —
 * and the `id` half of a key can be a client-supplied IP, so an attacker
 * cycling source addresses could grow this Map without bound. A sweep every
 * this-many calls reclaims expired windows regardless of who created them, at
 * a cost amortised over hundreds of requests.
 */
const SWEEP_EVERY = 256;
/** The longest window in RATE_LIMITS, so one sweep can age out any bucket. */
const MAX_WINDOW_MS = Math.max(...Object.values(RATE_LIMITS).map((c) => c.windowMs));
let callsSinceSweep = 0;

export function resetRateLimits(): void {
  windows.clear();
  callsSinceSweep = 0;
}

/** Test seam: how many keys the limiter is currently holding. */
export function rateLimitWindowCount(): number {
  return windows.size;
}

function sweep(now: number): void {
  const floor = now - MAX_WINDOW_MS;
  for (const [mapKey, hits] of windows) {
    // A window's hits are appended in increasing `now` order, so anything at or
    // before the floor is expired for every configured window.
    let firstAlive = 0;
    while (firstAlive < hits.length && hits[firstAlive] <= floor) firstAlive++;
    if (firstAlive === hits.length) windows.delete(mapKey);
    else if (firstAlive > 0) hits.splice(0, firstAlive);
  }
}

export function checkRateLimit(
  key: RateLimitKey,
  config: RateLimitConfig,
  now: number = Date.now(),
): RateLimitResult {
  callsSinceSweep += 1;
  if (callsSinceSweep >= SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweep(now);
  }

  const mapKey = `${key.bucket}:${key.id}`;
  let hits = windows.get(mapKey);
  if (!hits) {
    hits = [];
    windows.set(mapKey, hits);
  }

  // Drop entries that left the window
  const cutoff = now - config.windowMs;
  let firstAlive = 0;
  while (firstAlive < hits.length && hits[firstAlive] <= cutoff) firstAlive++;
  if (firstAlive > 0) hits.splice(0, firstAlive);

  if (hits.length >= config.max) {
    const oldest = hits[0];
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000)),
      remaining: 0,
    };
  }

  hits.push(now);
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: config.max - hits.length,
  };
}
