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
  /** 5 login attempts / 15 min per IP+username */
  login: { max: 5, windowMs: 15 * 60_000 },
  /** 20 general API requests / min per IP */
  api: { max: 20, windowMs: 60_000 },
  /** 10 chat turns / min per user */
  turn: { max: 10, windowMs: 60_000 },
  /** 5 CLI installs / hour per user */
  install: { max: 5, windowMs: 60 * 60_000 },
} as const satisfies Record<string, RateLimitConfig>;

const windows = new Map<string, number[]>();

export function resetRateLimits(): void {
  windows.clear();
}

export function checkRateLimit(
  key: RateLimitKey,
  config: RateLimitConfig,
  now: number = Date.now(),
): RateLimitResult {
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
