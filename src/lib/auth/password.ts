import { hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

/**
 * Argon2id password hashing — OWASP-recommended parameters for interactive
 * logins: m=19456 KiB (19 MiB), t=2, p=1. @node-rs/argon2 uses these as its
 * defaults; they are stated explicitly here so a library upgrade can never
 * silently weaken them.
 */
const ARGON2_OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Argon2 prehashes with BLAKE2b at 64 bytes; inputs are effectively capped
 * around 72 bytes in common implementations. Longer inputs are not weaker
 * per se, but we reject them up front so stored-length never leaks and so
 * verification cost is uniform. 256 is the max we accept at the API layer. */
export const MAX_PASSWORD_BYTES = 72;

function assertAcceptableLength(password: string): void {
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes > MAX_PASSWORD_BYTES) {
    throw new Error(
      `password exceeds ${MAX_PASSWORD_BYTES} bytes (got ${bytes}); use a shorter secret or a passphrase`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertAcceptableLength(password);
  return hash(Buffer.from(password, "utf8"), ARGON2_OPTS);
}

export async function verifyPassword(
  hashStr: string,
  password: string,
): Promise<boolean> {
  if (!hashStr.startsWith("$argon2")) return false;
  assertAcceptableLength(password);
  try {
    return await verify(hashStr, Buffer.from(password, "utf8"), ARGON2_OPTS);
  } catch {
    // Malformed hash, bad parameters string, etc. — a failed login, never a 500.
    return false;
  }
}

/**
 * Precomputed hash of a random value, used to equalize timing when the
 * username does not exist: run verifyPassword(DUMMY_HASH, password) for
 * unknown users so exists+verify and exists-only responses are
 * indistinguishable by latency.
 *
 * Generated once at module load would cost 19 MiB of Argon2 at every cold
 * start for no benefit — instead it is a fixed literal generated at build
 * time (first deploy). Value is not secret: it verifies a password nobody
 * holds.
 */
export const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$mDrX2H3t+8H9sbjfLTXcDg$TLwmNzY0i73nMi9b/RlGSJN9iBiP5cx0Urvl2YSxlKw";

/** One-time generator for DUMMY_HASH (run manually, paste the result above). */
export async function generateDummyHash(): Promise<string> {
  const random = randomBytes(32).toString("base64");
  return hash(Buffer.from(random), ARGON2_OPTS);
}
