import "server-only";
import fs from "node:fs";
import path from "node:path";
import { integrationSpec } from "./registry";
import { writeFileAtomically } from "@/lib/fs/atomic";
import type { ProviderId } from "@/lib/providers/types";
import type { CredentialStatus } from "./types";

/** Re-exported: the names-only status is the app public credential shape. */
export type { CredentialStatus };

/**
 * Credentials for third-party CLIs, stored in `data/integrations.env`
 * (mode 0600, gitignored) — never in SQLite, never in the process-wide env.
 *
 * The file exists so a credential survives a restart and can be handed to
 * exactly one child process. Every API surface exposes `configured: true|false`
 * only: values are read here, injected into that provider's spawn env, and
 * never returned, logged, or echoed back in an error.
 *
 * Claude is not handled here at all — it inherits the host's own login
 * (ledgered: no ANTHROPIC_API_KEY passthrough, host login wins).
 */

const FILE_NAME = "integrations.env";

/** Where the file lives. Under the DB's data directory, never /tmp. */
export function credentialsPath(databasePath: string): string {
  return path.join(path.dirname(databasePath), FILE_NAME);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask and is ignored for an existing dir;
  // chmod is what actually pins it.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // A dir we cannot chmod is still usable; the file's own mode is what
    // protects the secret.
  }
}

/**
 * Parse a dotenv-shaped file. Tolerates quotes and `export `, rejects nothing —
 * an unparsable line is skipped rather than failing every read.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Serialise deterministically (sorted keys) so diffs stay quiet. */
export function serializeEnvFile(values: Record<string, string>): string {
  return (
    Object.keys(values)
      .sort()
      .map((k) => `${k}=${values[k]}`)
      .join("\n") + "\n"
  );
}

function readAll(databasePath: string): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(credentialsPath(databasePath), "utf8"));
  } catch {
    return {}; // absent file = nothing configured
  }
}

/** Names only. Never a value. */
export function credentialStatus(
  databasePath: string,
  id: ProviderId,
): CredentialStatus {
  const spec = integrationSpec(id);
  if (!spec || spec.credentialKeys.length === 0) {
    return { configured: true, presentKeys: [] }; // host-login providers
  }
  const all = readAll(databasePath);
  const presentKeys = spec.credentialKeys.filter(
    (k) => typeof all[k] === "string" && all[k].length > 0,
  );
  // `"all"` is declared, never inferred: a provider whose keys are
  // alternatives (Codex: API key *or* device login) is usable with one.
  const configured =
    spec.credentialMode === "all"
      ? presentKeys.length === spec.credentialKeys.length
      : presentKeys.length > 0;
  return { configured, presentKeys };
}

/** Env to layer onto this provider's child process only. */
export function credentialEnvFor(
  databasePath: string,
  id: ProviderId,
): Record<string, string> {
  const spec = integrationSpec(id);
  if (!spec) return {};
  const all = readAll(databasePath);
  const out: Record<string, string> = {};
  for (const key of spec.credentialKeys) {
    const v = all[key];
    if (v) out[key] = v;
  }
  return out;
}

export type CredentialWriteError = "unknown_provider" | "no_credentials" | "invalid";

/**
 * Merge the given keys into the file, atomically and with mode 0600.
 *
 * Validation is by NAME against the provider's declared keys. Values must be
 * single-line, printable, 1..4096 bytes — a newline would forge another
 * variable in the file, which is the one injection this format has.
 */
export function writeCredentials(
  databasePath: string,
  id: ProviderId,
  values: Record<string, unknown>,
): { ok: true } | { ok: false; error: CredentialWriteError } {
  const spec = integrationSpec(id);
  if (!spec) return { ok: false, error: "unknown_provider" };
  if (spec.credentialKeys.length === 0) return { ok: false, error: "no_credentials" };

  const accepted: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (!spec.credentialKeys.includes(key)) return { ok: false, error: "invalid" };
    if (typeof raw !== "string") return { ok: false, error: "invalid" };
    const value = raw.trim();
    if (value.length === 0 || value.length > 4096) return { ok: false, error: "invalid" };
    if (/[\r\n\0]/.test(value)) return { ok: false, error: "invalid" };
    accepted[key] = value;
  }
  if (Object.keys(accepted).length === 0) return { ok: false, error: "invalid" };

  const file = credentialsPath(databasePath);
  ensurePrivateDir(path.dirname(file));
  const merged = { ...readAll(databasePath), ...accepted };
  // Forced 0600 regardless of what the file had: this one holds secrets, so a
  // widened mode is never "preserved".
  writeFileAtomically(file, serializeEnvFile(merged), { mode: 0o600 });
  return { ok: true };
}

/** Remove one provider's keys (leaving other providers' untouched). */
export function clearCredentials(
  databasePath: string,
  id: ProviderId,
): void {
  const spec = integrationSpec(id);
  if (!spec || spec.credentialKeys.length === 0) return;
  const file = credentialsPath(databasePath);
  const all = readAll(databasePath);
  let changed = false;
  for (const key of spec.credentialKeys) {
    if (key in all) {
      delete all[key];
      changed = true;
    }
  }
  if (!changed) return;
  ensurePrivateDir(path.dirname(file));
  writeFileAtomically(file, serializeEnvFile(all), { mode: 0o600 });
}
