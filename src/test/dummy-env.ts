import { resetEnvForTest } from "../lib/env";

/**
 * Set dummy Clerk env vars (never read real .env files — ledgered rule) and
 * reset the env cache, so modules under test can call getEnv() against a
 * valid-but-fake config. Call in beforeEach.
 */
export function useDummyEnv(overrides: Record<string, string> = {}): void {
  resetEnvForTest();
  Object.assign(process.env, {
    CLERK_SECRET_KEY: "sk_test_dummy",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_dummy",
    ...overrides,
  });
}

/** Drop the dummy values and reset the cache again. Call in afterEach. */
export function clearDummyEnv(): void {
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  for (const k of [
    "DATABASE_PATH",
    "ALLOWED_WORKSPACE_ROOTS",
    "DEFAULT_MODEL",
    "MAX_CONCURRENT_TURNS",
    "TURN_TIMEOUT_MS",
    "CLAUDE_EXECUTABLE",
    "ENABLED_PROVIDERS",
    "INSTALL_ALLOWLIST",
    "HOST",
    "PORT",
    "TRUST_PROXY",
  ]) {
    delete process.env[k];
  }
  resetEnvForTest();
}
