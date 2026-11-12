import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * Settings-file safety shared by every per-tool editor.
 *
 * These files are read AND written by the tools themselves and by the
 * operator's hand. Two rules follow, and both are load-bearing:
 *
 * 1. **A secret never leaves the server.** `env` blocks in particular are where
 *    tools keep API keys, so redaction runs by KEY NAME at any depth. The key
 *    stays visible so the editor can show that a value exists.
 *
 * 2. **Redaction round-trips.** If the browser posts the marker back unchanged,
 *    the stored value is preserved. Otherwise every save would overwrite a live
 *    API key with the literal string "***" — the single most destructive bug
 *    this module could have, and it would look like a successful save.
 */

/** The marker the editor shows in place of a secret. */
export const REDACTED = "***";

/**
 * Key names that hold secrets. Deliberately broad — a missed name leaks a live
 * credential, while a false positive only hides a harmless value behind a
 * marker the operator can still overwrite by typing a new one.
 *
 * Matching is word-based, not substring-based, because substring matching is
 * both too weak (`bearerToken`, `x-api-key`) and too eager (`keyboard`,
 * `keybindings`, `author`, `monkey` are real settings names). A key is split on
 * `_`, `-`, `.` and camelCase boundaries, and matches when any word is a secret
 * word; concatenated forms that never split (`clientsecret`) fall back to a
 * substring test over the words that do not occur in ordinary settings words.
 */
const SECRET_WORDS = new Set([
  "api",
  "apikey",
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "private",
  "session",
  "signature",
  "sig",
]);

/** Concatenated forms may never split into words; these substrings still leak. */
const SECRET_CONCATENATIONS = ["secret", "password", "passwd", "credential", "bearer"];

/**
 * Split an identifier into lowercase words: separators first, then camelCase
 * and acronym boundaries (`APIToken` → `api`, `token`; `myKey` → `my`, `key`).
 * The trailing `[a-z0-9]+` branch is what keeps an ordinary lowercase segment
 * (`api_key` → `api`, `key`) from vanishing.
 */
function words(key: string): string[] {
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((segment) => segment.match(/[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z0-9]+/g) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

/** True when a settings key's VALUE should never be sent to the browser. */
export function isSecretKey(key: string): boolean {
  const parts = words(key);
  if (parts.some((word) => SECRET_WORDS.has(word))) return true;
  const joined = parts.join("");
  return SECRET_CONCATENATIONS.some((needle) => joined.includes(needle));
}

/**
 * Deep-copy `value` with every secret-keyed entry replaced by the marker.
 * Arrays are walked (MCP servers nest env blocks inside them); functions and
 * primitives pass through, and nothing is ever mutated.
 *
 * A secret-named key is replaced WHOLESALE, whatever its value: an array or
 * object under `secrets`/`credentials` is still a secret, and walking it only
 * re-tests its leaves, which let `{ secrets: ["abc"] }` through in the clear.
 * Empty strings and nulls stay as they are — they are how a settings editor
 * shows "no value set", and the marker would claim one exists.
 */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = entry === "" || entry === null || entry === undefined ? entry : REDACTED;
    } else {
      out[key] = redactValue(entry);
    }
  }
  return out;
}

/**
 * Reconcile a submitted document with what is on disk. Every secret-keyed value
 * that is still exactly the marker takes the stored value; anything else the
 * operator typed is used verbatim. Non-secret keys and array structure come
 * from the submission, because that is what the editor actually shows.
 *
 * Arrays merge element-wise when both sides have the same length, passing the
 * stored element as the restoration source. Without that, `mergeRedacted(
 * undefined, entry)` gave every array element an empty stored side, so a
 * marker inside `servers: [{ env: { API_KEY } }]` collapsed to `{}` and the
 * save silently deleted the key. When the lengths differ the editor
 * restructured the list and positional matching would restore the wrong
 * secret, so the submission wins.
 */
export function mergeRedacted(stored: unknown, submitted: unknown): unknown {
  if (Array.isArray(submitted)) {
    const storedArray = Array.isArray(stored) ? stored : null;
    const restore = storedArray && storedArray.length === submitted.length ? storedArray : null;
    return submitted.map((entry, index) => mergeRedacted(restore?.[index], entry));
  }
  if (submitted === null || typeof submitted !== "object") return submitted;

  const storedObj =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(submitted as Record<string, unknown>)) {
    if (isSecretKey(key) && value === REDACTED) {
      // Keep whatever the file already had; an absent stored value stays absent
      // rather than becoming the literal marker.
      if (key in storedObj) out[key] = storedObj[key];
      continue;
    }
    out[key] = mergeRedacted(storedObj[key], value);
  }
  return out;
}

export type SettingsFormat = "json" | "toml";

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/**
 * Parse a settings document the editor submitted. Empty text means an empty
 * document (both formats allow it). The failure message is written for the
 * editor to display under the textarea, so it names the format, not the stack.
 */
export function validateSettingsText(
  format: SettingsFormat,
  text: string,
): ValidationResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: {} };

  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return { ok: false, message: `Not valid JSON: ${describeJsonError(error)}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, message: "A settings file must be a JSON object" };
    }
    return { ok: true, value: parsed };
  }

  try {
    return { ok: true, value: parseToml(trimmed) };
  } catch (error) {
    return { ok: false, message: `Not valid TOML: ${describeTomlError(error)}` };
  }
}

/** Body schema for a settings PUT — size-capped so a paste cannot wedge a write. */
export const settingsPayloadSchema = z.object({
  text: z.string().max(512 * 1024, "Settings file is too large"),
});

/**
 * Summarise a JSON parse failure WITHOUT quoting the input.
 *
 * V8's message for "Unexpected token" quotes the surrounding bytes — and this
 * message goes into the GET response, where the whole point of refusing an
 * unparseable file is not to hand the browser bytes the redaction never saw. A
 * dropped quote next to an API key therefore used to leak the key. The
 * position alone is enough for the editor to point at the line.
 */
function describeJsonError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const at = /at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(message);
  if (at) {
    return at[2] ? `unexpected syntax at line ${at[2]}, column ${at[3]}` : `unexpected syntax at position ${at[1]}`;
  }
  if (/Unexpected end of JSON input/.test(message)) return "unexpected end of input";
  return "unexpected syntax";
}

/**
 * TOML parser messages are prose ("invalid value", "illegal character in
 * numeric literal") with the offending line quoted after a blank line. Drop
 * everything from the first newline so no input bytes survive; the first line
 * is the sentence the editor has room for and names no content.
 */
function describeTomlError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = (message.split("\n")[0] ?? "").trim();
  return first === "" ? "parse error" : first.replace(/^Invalid TOML document:\s*/i, "");
}
