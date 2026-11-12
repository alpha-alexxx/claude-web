/**
 * The four tools this app drives, in display order, with one label vocabulary.
 *
 * Skills, plugins, MCP and the per-tool settings editors all address the same
 * four ids, and each of them had started spelling its own label table. One
 * table here means a rename (or a fifth tool) happens once, and a page can
 * never call the same CLI two different things.
 *
 * Plain module: no `server-only`, no filesystem — it is imported by Client
 * Components.
 */

export type ToolId = "claude" | "codex" | "opencode" | "qoder";

export const TOOL_IDS: readonly ToolId[] = ["claude", "codex", "opencode", "qoder"];

export const TOOL_LABELS: Record<ToolId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  qoder: "Qoder",
};
