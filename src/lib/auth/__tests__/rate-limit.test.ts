import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  resetRateLimits,
  RATE_LIMITS,
} from "../rate-limit";

beforeEach(() => {
  resetRateLimits();
});

describe("sliding-window limiter", () => {
  it("allows requests under the limit and counts up", () => {
    const key = { bucket: "login", id: "1.2.3.4:alice" };
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      const r = checkRateLimit(key, RATE_LIMITS.login, Date.now());
      expect(r.allowed).toBe(true);
    }
    // Next one is over
    const over = checkRateLimit(key, RATE_LIMITS.login, Date.now());
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
  });

  it("keys are isolated — different id gets its own window", () => {
    const a = { bucket: "login", id: "1.2.3.4:alice" };
    const b = { bucket: "login", id: "1.2.3.4:bob" };
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      checkRateLimit(a, RATE_LIMITS.login, Date.now());
    }
    expect(checkRateLimit(a, RATE_LIMITS.login, Date.now()).allowed).toBe(false);
    expect(checkRateLimit(b, RATE_LIMITS.login, Date.now()).allowed).toBe(true);
  });

  it("buckets are isolated — same id in a different bucket is unaffected", () => {
    const login = { bucket: "login", id: "k" };
    const api = { bucket: "api", id: "k" };
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      checkRateLimit(login, RATE_LIMITS.login, Date.now());
    }
    expect(checkRateLimit(login, RATE_LIMITS.login, Date.now()).allowed).toBe(false);
    expect(checkRateLimit(api, RATE_LIMITS.api, Date.now()).allowed).toBe(true);
  });

  it("frees the window after the period elapses", () => {
    const key = { bucket: "login", id: "k" };
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      checkRateLimit(key, RATE_LIMITS.login, t0);
    }
    expect(checkRateLimit(key, RATE_LIMITS.login, t0).allowed).toBe(false);
    // 15 minutes + 1 s later
    const later = t0 + RATE_LIMITS.login.windowMs + 1000;
    expect(checkRateLimit(key, RATE_LIMITS.login, later).allowed).toBe(true);
  });

  it("reports correct retryAfterSec when blocked", () => {
    const key = { bucket: "login", id: "k" };
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMITS.login.max; i++) {
      checkRateLimit(key, RATE_LIMITS.login, t0);
    }
    const blocked = checkRateLimit(key, RATE_LIMITS.login, t0 + 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(
      RATE_LIMITS.login.windowMs / 1000,
    );
  });

  it("prunes old entries so memory stays bounded", () => {
    const key = { bucket: "login", id: "k" };
    const t0 = Date.now();
    // Many distinct old timestamps
    for (let i = 0; i < RATE_LIMITS.login.max * 3; i++) {
      checkRateLimit(key, RATE_LIMITS.login, t0 - 60_000 * i);
    }
    // All old entries are outside the window; the counter should be usable
    const r = checkRateLimit(key, RATE_LIMITS.login, t0 + RATE_LIMITS.login.windowMs);
    expect(r.allowed).toBe(true);
  });
});

describe("configured limits", () => {
  it("exposes the planned production limits", () => {
    expect(RATE_LIMITS.login).toEqual({ max: 5, windowMs: 15 * 60_000 });
    expect(RATE_LIMITS.api.max).toBe(20);
    expect(RATE_LIMITS.api.windowMs).toBe(60_000);
    expect(RATE_LIMITS.turn.max).toBe(10);
    expect(RATE_LIMITS.turn.windowMs).toBe(60_000);
    expect(RATE_LIMITS.install.max).toBe(5);
    expect(RATE_LIMITS.install.windowMs).toBe(60 * 60_000);
  });
});
