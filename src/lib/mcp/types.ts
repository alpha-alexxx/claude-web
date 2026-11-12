import type { McpServer, McpTarget } from "@/lib/mcp/registry";
import { TOOL_LABELS } from "@/lib/tools";

/**
 * Wire contract for the MCP page. Plain module — no `server-only`, no
 * `smol-toml` — so the Client Component tree can name these shapes without
 * pulling the TOML generator into the browser bundle.
 */

export type { McpServer, McpTarget };

export interface McpRegistryView {
  servers: McpServer[];
}

export interface McpSyncOutcome {
  ok: boolean;
  /** The config file that was written (present on success). */
  path?: string;
  /** How many enabled servers were written. */
  count?: number;
  code?: string;
  message?: string;
}

export const MCP_TOOLS: { id: McpTarget; label: string; file: string }[] = [
  { id: "claude", label: TOOL_LABELS.claude, file: "~/.claude.json" },
  { id: "codex", label: TOOL_LABELS.codex, file: "~/.codex/config.toml" },
  { id: "opencode", label: TOOL_LABELS.opencode, file: "~/.config/opencode/opencode.json" },
  { id: "qoder", label: TOOL_LABELS.qoder, file: "~/.qoder/settings.json" },
];
