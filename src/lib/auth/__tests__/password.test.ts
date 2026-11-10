import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, DUMMY_HASH } from "../password";
import { randomBytes } from "node:crypto";

describe("hashPassword", () => {
  it("produces an argon2id hash with the planned parameters", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    // m=19456 KiB, t=2, p=1
    expect(hash).toContain("m=19456");
    expect(hash).toContain("t=2");
    expect(hash).toContain("p=1");
  });

  it("generates a unique salt per call", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    expect(a).not.toBe(b);
  });

  it("rejects passwords over 72 bytes (argon2 prehash truncation)", async () => {
    const long = randomBytes(73).toString("hex"); // 146 bytes, valid chars
    await expect(hashPassword(long)).rejects.toThrow(/72/);
    // Exactly 72 bytes is fine
    await expect(hashPassword("x".repeat(72))).resolves.toMatch(/^\$argon2id\$/);
  });
});

describe("verifyPassword", () => {
  it("accepts the correct password", async () => {
    const hash = await hashPassword("hunter2hunter2!");
    expect(await verifyPassword(hash, "hunter2hunter2!")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2hunter2!");
    expect(await verifyPassword(hash, "wrong-password!")).toBe(false);
  });

  it("rejects a malformed hash without throwing", async () => {
    expect(await verifyPassword("not-a-hash", "whatever-pass")).toBe(false);
    expect(await verifyPassword("", "whatever-pass")).toBe(false);
  });

  it("rejects over-72-byte passwords without hashing", async () => {
    const long = randomBytes(73).toString("hex");
    const hash = await hashPassword("normal-password-12");
    await expect(verifyPassword(hash, long)).rejects.toThrow(/72/);
  });
});

describe("unknown-user timing equalization", () => {
  it("exports a precomputed dummy hash that verifies like a real one", async () => {
    expect(DUMMY_HASH).toMatch(/^\$argon2id\$/);
    // Verifying against the dummy must succeed structurally (not throw),
    // so login can do: user ? verify(hash, pw) : verify(DUMMY_HASH, pw)
    const start = performance.now();
    const result = await verifyPassword(DUMMY_HASH, "any-guess-at-all");
    const elapsed = performance.now() - start;
    expect(typeof result).toBe("boolean");
    // Argon2id at m=19456/t=2 takes ≥50ms; if it returned instantly the
    // equalization path is broken.
    expect(elapsed).toBeGreaterThan(20);
  });

  it("takes comparable time for real and dummy verification", async () => {
    const hash = await hashPassword("real-password-here");
    const t1 = performance.now();
    await verifyPassword(hash, "real-password-here");
    const mid = performance.now();
    await verifyPassword(DUMMY_HASH, "wrong-guess-here!");
    const end = performance.now();
    const real = mid - t1;
    const dummy = end - mid;
    // Same parameters → same work. Allow generous jitter (CI variance).
    expect(dummy).toBeGreaterThan(real * 0.3);
    expect(dummy).toBeLessThan(real * 3 + 50);
  });
});
