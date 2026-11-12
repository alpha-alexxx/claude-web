import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * The render-token signing key: 32 random bytes generated once into
 * `data/render.key`, mode 0600, beside `integrations.env`.
 *
 * Generated rather than configured (ledgered): the env schema has no session
 * secret since Clerk took over, and adding a required variable would break
 * every existing `.env` at boot for a key with exactly one consumer. The file
 * lives next to the database because that is the app's own private directory —
 * `dirname(DATABASE_PATH)`, the same convention credentials.ts uses — and
 * therefore inherits the 0700 mode the data directory is created with.
 *
 * `wx` on create is load-bearing: two workers booting at once must not each
 * write a key and leave the loser verifying with a stale one. The loser gets
 * EEXIST and re-reads the winner's key.
 */

const FILE_NAME = "render.key";
const KEY_BYTES = 32;

export function renderKeyPath(databasePath: string): string {
  return path.join(path.dirname(databasePath), FILE_NAME);
}

/** Key cache per path, so a request path does not stat the file every time. */
const cache = new Map<string, Buffer>();

/** Test hook: forget any cached key. */
export function resetRenderKeyForTest(): void {
  cache.clear();
}

export function loadRenderKey(databasePath: string): Buffer {
  const file = renderKeyPath(databasePath);
  const cached = cache.get(file);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    // Same trade-off as credentials.ts: the file's own mode protects the key.
  }

  let key: Buffer;
  try {
    fs.writeFileSync(file, crypto.randomBytes(KEY_BYTES), { flag: "wx", mode: 0o600 });
    key = fs.readFileSync(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // umask may have widened it; chmod is what actually pins the mode.
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    key = fs.readFileSync(file);
  }

  if (key.length !== KEY_BYTES) {
    // A truncated or replaced key file must be loud: every in-flight token
    // dies, and silently signing with a short key is worse than a 500.
    throw new Error(
      `render key at ${file} is ${key.length} bytes, expected ${KEY_BYTES} — delete it to regenerate`,
    );
  }

  cache.set(file, key);
  return key;
}
