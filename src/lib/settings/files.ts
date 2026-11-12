import "server-only";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { modeFor, resolveWritePath, writeFileAtomically } from "@/lib/fs/atomic";
import {
  mergeRedacted,
  redactValue,
  validateSettingsText,
  type SettingsFormat,
} from "./redact";
import type { SettingsReadResult, SettingsTool } from "./types";

/**
 * Per-tool settings files: read redacted, write atomically, back up first.
 *
 * The write path is deliberately more careful than a plain `writeFile` because
 * this is the operator's own config, frequently hand-edited, and sometimes the
 * only copy:
 *
 *   - validate BEFORE touching disk, so a typo in the editor cannot empty the
 *     file it was editing;
 *   - copy the previous contents to `<file>.bak-<timestamp>` first;
 *   - write a temp file in the same directory and `rename` it into place, so a
 *     crash mid-write leaves the original intact;
 *   - keep the destination's existing mode (or 0600 for a new file) rather than
 *     letting the umask decide.
 *
 * Reads return redacted TEXT as well as a redacted value. That is not
 * belt-and-braces: a file that fails to parse is still shown to the editor so
 * the operator can repair it, and handing back the raw bytes there would leak
 * exactly the secrets the parse was supposed to hide.
 */

/**
 * The wire shapes live in `./types` so the browser can name them without this
 * module's `server-only` marker; re-exported here because every server caller
 * of this file already imports them from it.
 */
export type { SettingsTool, SettingsReadResult };

export interface ToolSettingsTarget {
  tool: SettingsTool;
  format: SettingsFormat;
}

export type SettingsWriteResult =
  | { ok: true; backup: string | null; path: string }
  | { ok: false; code: string; message: string };

export const SETTINGS_TARGETS: Record<SettingsTool, ToolSettingsTarget> = {
  claude: { tool: "claude", format: "json" },
  codex: { tool: "codex", format: "toml" },
  opencode: { tool: "opencode", format: "json" },
  qoder: { tool: "qoder", format: "json" },
};

/** The file each tool reads for its own settings. */
export function settingsFilePath(home: string, tool: SettingsTool): string {
  switch (tool) {
    case "claude":
      return join(home, ".claude", "settings.json");
    case "codex":
      return join(home, ".codex", "config.toml");
    case "opencode":
      return join(home, ".config", "opencode", "opencode.json");
    case "qoder":
      return join(home, ".qoder", "settings.json");
  }
}

/** Read one tool's settings, redacted. A missing file is normal, not an error. */
export function readSettingsFile(
  home: string,
  target: ToolSettingsTarget,
): SettingsReadResult {
  const path = settingsFilePath(home, target.tool);
  const raw = readOrNull(path);
  if (raw === null) {
    return { path, exists: false, text: "", value: {}, parsed: true };
  }

  const validation = validateSettingsText(target.format, raw);
  if (!validation.ok) {
    // Do not echo an unparseable file: it may contain a secret the parse would
    // have redacted. Show a redacted skeleton instead, with the reason.
    return {
      path,
      exists: true,
      text: "",
      value: {},
      parsed: false,
      message: validation.message,
    };
  }

  const value = redactValue(validation.value);
  return {
    path,
    exists: true,
    // A file with no secrets is shown byte-for-byte: re-serializing it would
    // strip TOML comments and churn the operator's formatting for no benefit.
    // Once a secret is present the text must be regenerated from the redacted
    // value, since in-place substitution in the raw bytes is not safe to do.
    text: sameJson(value, validation.value)
      ? raw
      : serialize(target.format, value),
    value,
    parsed: true,
  };
}

/**
 * Validate and write one tool's settings file. `submitted` is the editor's text;
 * secrets still carrying the redaction marker are restored from disk so a save
 * never destroys a stored credential.
 */
export function applySettingsWrite(
  home: string,
  target: ToolSettingsTarget,
  submitted: string,
): SettingsWriteResult {
  const path = settingsFilePath(home, target.tool);

  const validation = validateSettingsText(target.format, submitted);
  if (!validation.ok) {
    return { ok: false, code: "invalid_settings", message: validation.message };
  }

  const storedRaw = readOrNull(path);
  let stored: unknown = {};
  if (storedRaw !== null) {
    const storedValidation = validateSettingsText(target.format, storedRaw);
    // A stored file we cannot parse must not be merged into: there is nothing
    // trustworthy to restore markers from, and merging `{}` would silently
    // drop whatever the file said.
    if (!storedValidation.ok) {
      return {
        ok: false,
        code: "stored_unparseable",
        message: `The existing ${path} does not parse; fix it by hand before saving from here`,
      };
    }
    stored = storedValidation.value;
  }

  const merged = mergeRedacted(stored, validation.value);

  // Saving the redacted text back unchanged is the common case (open, look,
  // save). Writing it would replace the operator's file with our serialization
  // and silently drop their TOML comments, so treat it as a no-op instead.
  if (storedRaw !== null && sameJson(merged, stored)) {
    return { ok: true, backup: null, path };
  }

  const text = ensureTrailingNewline(serialize(target.format, merged));

  let backup: string | null = null;
  try {
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (storedRaw !== null) backup = writeBackup(path, storedRaw);
    writeFileAtomically(path, text);
  } catch (error) {
    return {
      ok: false,
      code: "write_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, backup, path };
}

/** Wraps `applySettingsWrite` for the route layer's default home. */
export function applySettingsWriteForHome(
  target: ToolSettingsTarget,
  submitted: string,
): SettingsWriteResult {
  return applySettingsWrite(homedir(), target, submitted);
}

// -- internals ---------------------------------------------------------------

function serialize(format: SettingsFormat, value: unknown): string {
  if (format === "json") return `${JSON.stringify(value, null, 2)}`;
  return stringifyToml((value ?? {}) as Record<string, unknown>);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Structural equality via JSON, used only to answer "did this save change
 * anything?", where key order is identical on both sides because both values
 * come from the same parser.
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function writeBackup(path: string, contents: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Beside the REAL file: for a dotfiles symlink that is the repo copy, not
  // the link's directory, so the operator finds the backup next to what it
  // backs up and ~/.claude is not littered with stray copies.
  const backup = `${resolveWritePath(path)}.bak-${stamp}`;
  fs.writeFileSync(backup, contents, { mode: modeFor(path) });
  return backup;
}

function readOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
