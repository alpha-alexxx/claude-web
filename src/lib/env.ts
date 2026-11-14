import "server-only";
import { z } from "zod";

/**
 * Server-side environment configuration, parsed once and validated strictly.
 * Never import from client components. Access via `getEnv()` (cached) —
 * reading process.env directly elsewhere is what this module exists to stop.
 *
 * Fails fast at boot: missing Clerk keys or a malformed numeric setting throw
 * here rather than producing a half-configured server.
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

  /** Clerk server key. Never imported by client code — env.ts is
   * server-only by convention and by the `server-only` import below. */
  CLERK_SECRET_KEY: z
    .string()
    .min(1, "CLERK_SECRET_KEY is required (set it in .env)")
    .startsWith("sk_", "CLERK_SECRET_KEY must start with sk_"),

  /** Clerk publishable key. Safe to ship to the browser by design, but it is
   * still read here so a typo fails at boot instead of at first render. */
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .min(1, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required (set it in .env)")
    .startsWith(
      "pk_",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_ — a secret key must never be placed in a NEXT_PUBLIC_ variable",
    ),

  /** Bind address. `localhost`, not `127.0.0.1`: Next normalizes every
   * loopback request host to the literal `localhost`, and the router compares a
   * proxy rewrite against an origin built from this value — a different
   * spelling makes own-origin rewrites look external (self-proxy, `EPROTO`
   * through a TLS tunnel). Both names reach the same socket. */
  HOST: z.string().default("localhost"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8765),

  /** Trust X-Forwarded-For from the direct peer (your
   * reverse proxy). Leave false when exposed directly. */
  TRUST_PROXY: boolish,

  /** Per-conversation cwd containment. Empty = workspaces feature disabled. */
  ALLOWED_WORKSPACE_ROOTS: csvList(),

  /** Dev-only. Tunnel hostnames the dev server trusts for `/_next` and
   * `/_nextjs` requests. `next.config.ts` reads this key directly, because it is
   * loaded outside the app runtime and cannot import this schema; it is parsed
   * here too so a typo is visible at boot rather than as a 403 on an asset URL. */
  ALLOWED_DEV_ORIGINS: csvList(),

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
