import { z } from "zod";

/**
 * Server-side environment configuration, parsed once and validated strictly.
 * Never import from client components. Access via `getEnv()` (cached) —
 * reading process.env directly elsewhere is what this module exists to stop.
 *
 * Fails fast at boot: a missing/short SESSION_SECRET or a malformed numeric
 * setting throws here rather than producing a half-configured server.
 */

const boolish = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const csvList = (def = "") =>
  z
    .string()
    .default(def)
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    );

const EnvSchema = z.object({
  /** SQLite file path. Parent dir is created by the db client. */
  DATABASE_PATH: z.string().default("./data/claude-web.db"),

  /** >=32 bytes; used for CSRF HMAC signing and future cookie binding. */
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 bytes (generate with: openssl rand -base64 48)"),

  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8765),

  /** Whether to mark the session cookie Secure. `auto` = true when the
   * request came in over HTTPS (x-forwarded-proto, only honored when
   * TRUST_PROXY). */
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),

  /** Trust X-Forwarded-For / X-Forwarded-Proto from the direct peer (your
   * reverse proxy). Leave false when exposed directly. */
  TRUST_PROXY: boolish,

  /** Per-conversation cwd containment. Empty = workspaces feature disabled. */
  ALLOWED_WORKSPACE_ROOTS: csvList(),

  DEFAULT_MODEL: z.string().default("auto"),

  /** Cap on concurrently active SDK query processes (each can be ~1 GiB). */
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(8).default(2),

  /** Hard kill for a turn that streams this long without completing. */
  TURN_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(1_800_000),

  /** Optional pathToClaudeCodeExecutable override. */
  CLAUDE_EXECUTABLE: z.string().optional(),

  /** Which provider adapters may be activated. */
  ENABLED_PROVIDERS: csvList("claude").transform((list) => {
    const known = ["claude", "codex", "opencode", "qoder"];
    for (const p of list) {
      if (!known.includes(p)) {
        throw new Error(
          `ENABLED_PROVIDERS contains unknown provider "${p}" (known: ${known.join(", ")})`,
        );
      }
    }
    return list;
  }),

  /** Exact-pinned package specs that Integrations may install. Empty list =
   * server-side installs are disabled entirely. */
  INSTALL_ALLOWLIST: csvList(),

  /** Allow /api/setup from non-loopback origins (single-operator VPS with a
   * tunnel, etc). Off by default. */
  SETUP_ALLOW_REMOTE: boolish,
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;

/** Parse and cache process.env. Throws (fail-fast) on invalid config. */
export function getEnv(): AppEnv {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** Test seam: drop the cached env so the next getEnv() re-reads. */
export function resetEnvForTest(): void {
  cached = null;
}

/**
 * Parse an arbitrary env-like record. Exported for tests; boot code uses
 * getEnv(). Error messages name the offending variable.
 */
export function parseEnv(source: Record<string, string | undefined>): AppEnv {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid environment configuration — ${issues}`);
  }
  return result.data;
}
