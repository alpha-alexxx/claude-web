import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  rateLimitWindowCount,
  resetRateLimits,
  RATE_LIMITS,
} from "../rate-limit";

beforeEach(() => {
  resetRateLimits();
});

describe("sliding-window limiter", () => {
  it("allows requests under the limit and counts up", () => {
    const key = { bucket: "turn", id: "1.2.3.4:alice" };
    for (let i = 0; i < RATE_LIMITS.turn.max; i++) {
      const r = checkRateLimit(key, RATE_LIMITS.turn, Date.now());
      expect(r.allowed).toBe(true);
    }
    // Next one is over
    const over = checkRateLimit(key, RATE_LIMITS.turn, Date.now());
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it("keys are isolated — different id gets its own window", () => {
    const a = { bucket: "turn", id: "1.2.3.4:alice" };
    const b = { bucket: "turn", id: "1.2.3.4:bob" };
    for (let i = 0; i < RATE_LIMITS.turn.max; i++) {
      checkRateLimit(a, RATE_LIMITS.turn, Date.now());
    }
    expect(checkRateLimit(a, RATE_LIMITS.turn, Date.now()).allowed).toBe(false);
    expect(checkRateLimit(b, RATE_LIMITS.turn, Date.now()).allowed).toBe(true);
  });

  it("buckets are isolated — same id in a different bucket is unaffected", () => {
    const turn = { bucket: "turn", id: "k" };
    const api = { bucket: "integrations", id: "k" };
    for (let i = 0; i < RATE_LIMITS.turn.max; i++) {
      checkRateLimit(turn, RATE_LIMITS.turn, Date.now());
    }
    expect(checkRateLimit(turn, RATE_LIMITS.turn, Date.now()).allowed).toBe(false);
    expect(checkRateLimit(api, RATE_LIMITS.integrations, Date.now()).allowed).toBe(true);
  });

  it("frees the window after the period elapses", () => {
    const key = { bucket: "turn", id: "k" };
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMITS.turn.max; i++) {
      checkRateLimit(key, RATE_LIMITS.turn, t0);
    }
    expect(checkRateLimit(key, RATE_LIMITS.turn, t0).allowed).toBe(false);
    // one window + 1 s later
    const later = t0 + RATE_LIMITS.turn.windowMs + 1000;
    expect(checkRateLimit(key, RATE_LIMITS.turn, later).allowed).toBe(true);
  });

  it("reports correct retryAfterSec when blocked", () => {
    const key = { bucket: "turn", id: "k" };
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMITS.turn.max; i++) {
      checkRateLimit(key, RATE_LIMITS.turn, t0);
    }
    const blocked = checkRateLimit(key, RATE_LIMITS.turn, t0 + 1_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(
      RATE_LIMITS.turn.windowMs / 1000,
    );
  });

  it("prunes old entries so memory stays bounded", () => {
    const key = { bucket: "turn", id: "k" };
    const t0 = Date.now();
    // Many distinct old timestamps
    for (let i = 0; i < RATE_LIMITS.turn.max * 3; i++) {
      checkRateLimit(key, RATE_LIMITS.turn, t0 - 60_000 * i);
    }
    // All old entries are outside the window; the counter should be usable
    const r = checkRateLimit(key, RATE_LIMITS.turn, t0 + RATE_LIMITS.turn.windowMs);
    expect(r.allowed).toBe(true);
  });

  it("evicts whole windows that expired, so the Map cannot grow per client id", () => {
    // The id half of a key can be a client-supplied IP. Without a sweep, every
    // address that ever hit a route would stay in this Map for the process
    // lifetime — a memory leak an attacker controls.
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
      checkRateLimit({ bucket: "turn", id: `10.0.0.${i}` }, RATE_LIMITS.turn, t0);
    }
    expect(rateLimitWindowCount()).toBe(300);

    // Far beyond every configured window, keep calling until the sweep's
    // cadence comes round again: the 300 stale keys must all be reclaimed.
    const longAfter = t0 + RATE_LIMITS.install.windowMs + 1;
    for (let i = 0; i < 300; i++) {
      checkRateLimit({ bucket: "turn", id: "10.9.9.9" }, RATE_LIMITS.turn, longAfter);
    }
    expect(rateLimitWindowCount()).toBe(1);
  });

  it("a sweep leaves live windows alone", () => {
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) {
      checkRateLimit({ bucket: "turn", id: `a${i}` }, RATE_LIMITS.turn, t0);
    }
    // Same instant as the writes: nothing has aged out, so nothing is evicted.
    checkRateLimit({ bucket: "turn", id: "trip" }, RATE_LIMITS.turn, t0);
    expect(rateLimitWindowCount()).toBe(301);
    // And the counters still hold: a swept-but-live key is still limited.
    const key = { bucket: "turn", id: "a0" };
    for (let i = 0; i < RATE_LIMITS.turn.max - 1; i++) {
      checkRateLimit(key, RATE_LIMITS.turn, t0);
    }
    expect(checkRateLimit(key, RATE_LIMITS.turn, t0).allowed).toBe(false);
  });
});

describe("configured limits", () => {
  it("exposes the planned production limits", () => {
    expect(RATE_LIMITS.integrations.max).toBe(30);
    expect(RATE_LIMITS.integrations.windowMs).toBe(60_000);
    expect(RATE_LIMITS.turn.max).toBe(10);
    expect(RATE_LIMITS.turn.windowMs).toBe(60_000);
    expect(RATE_LIMITS.install.max).toBe(5);
    expect(RATE_LIMITS.install.windowMs).toBe(60 * 60_000);
    expect(RATE_LIMITS.render.max).toBe(60);
    expect(RATE_LIMITS.render.windowMs).toBe(60_000);
    // Redemption is deliberately more generous than minting but still finite:
    // a token is reusable for five minutes, so this is the only bound on reads.
    expect(RATE_LIMITS.renderRead.max).toBe(180);
    expect(RATE_LIMITS.renderRead.windowMs).toBe(60_000);
  });
});
