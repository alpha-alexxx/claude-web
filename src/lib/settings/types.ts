/**
 * Wire contract for the per-tool settings editors. Plain module — no
 * `server-only` — so the Client Component tree can name these shapes without
 * pulling the filesystem layer into the browser bundle.
 */

import { TOOL_LABELS } from "@/lib/tools";

export type SettingsTool = "claude" | "codex" | "opencode" | "qoder";

/** A tool's settings as the editor sees them: redacted, possibly unparseable. */
export interface SettingsReadResult {
  path: string;
  exists: boolean;
  /** Redacted text for the editor (raw text when it parsed cleanly). */
  text: string;
  /** Redacted parsed value; `{}` when missing or unparseable. */
  value: unknown;
  parsed: boolean;
  /** Why the file did not parse, for the editor's message line. */
  message?: string;
}

export interface SettingsSaveResult {
  ok: boolean;
  /** Where the file was written (present on success). */
  path?: string;
  /** The backup made before the write; null when nothing was rewritten. */
  backup?: string | null;
  code?: string;
  message?: string;
}

/**
 * Display names, so the four editors share one label vocabulary.
 * Re-exported from the app-wide table rather than spelled again here — the
 * four tools are addressed by the same names on skills, plugins, MCP and
 * settings, and a local copy is how those drift apart.
 */
export const SETTINGS_TOOL_LABELS: Record<SettingsTool, string> = TOOL_LABELS;

/** The file each editor says it edits, for a page that renders before a read. */
export const SETTINGS_TOOL_FILES: Record<SettingsTool, string> = {
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  opencode: "~/.config/opencode/opencode.json",
  qoder: "~/.qoder/settings.json",
};

export const SETTINGS_TOOL_FORMATS: Record<SettingsTool, "json" | "toml"> = {
  claude: "json",
  codex: "toml",
  opencode: "json",
  qoder: "json",
};
