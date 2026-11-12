import "server-only";
import fs from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "@/lib/fs/atomic";
import {
  mcpServerSchema,
  mergeMcpConfig,
  mergeTomlMcp,
  type JsonConfig,
  type McpServer,
  type McpTarget,
} from "./registry";

/**
 * The app-owned MCP registry, and the push into each tool's native config.
 *
 * Two files are involved and they are NOT the same thing:
 *
 *   - `data/mcp-servers.json` — the app's own list, the thing the UI edits. One
 *     source of truth, validated on the way in AND on the way out.
 *   - `~/.claude.json`, `~/.codex/config.toml`, … — each tool's own file. No
 *     tool reads another's, so generation is the only mechanism that works.
 *     Merging is ownership-based: only servers the registry names are ours to
 *     rewrite, so a hand-added server survives every sync.
 *
 * Syncing refuses rather than guesses. If a tool's config file does not parse,
 * the tool itself is broken and writing over it would destroy whatever the
 * operator was in the middle of fixing — so the sync reports the file and
 * leaves it alone.
 */

const REGISTRY_FILE = "mcp-servers.json";

/** Where each tool reads MCP servers from, relative to the home directory. */
export function mcpConfigPath(home: string, tool: McpTarget): string {
  switch (tool) {
    case "claude":
      return join(home, ".claude.json");
    case "codex":
      return join(home, ".codex", "config.toml");
    case "opencode":
      return join(home, ".config", "opencode", "opencode.json");
    case "qoder":
      return join(home, ".qoder", "settings.json");
  }
}

/** Read the app's registry. Invalid entries are dropped, never repaired. */
export function readMcpRegistry(dataDir: string): McpServer[] {
  const raw = readOrNull(join(dataDir, REGISTRY_FILE));
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const servers: McpServer[] = [];
  for (const entry of parsed) {
    const result = mcpServerSchema.safeParse(entry);
    if (result.success) servers.push(result.data);
  }
  return servers;
}

/** Replace the whole registry. Atomic: temp file, chmod, rename. */
export function writeMcpRegistry(dataDir: string, servers: McpServer[]): void {
  const path = join(dataDir, REGISTRY_FILE);
  writeFileAtomically(path, `${JSON.stringify(servers, null, 2)}\n`, {
    mode: 0o600,
  });
}

export type SyncMcpResult =
  | { ok: true; path: string; count: number }
  | { ok: false; path: string; reason: string };

/**
 * Push the registry into one tool's native config, preserving everything the
 * registry does not own. Returns the file it wrote so the UI can say where.
 */
export function syncMcpToTool(
  home: string,
  dataDir: string,
  tool: McpTarget,
): SyncMcpResult {
  const path = mcpConfigPath(home, tool);
  const servers = readMcpRegistry(dataDir);
  const existing = readOrNull(path);

  let text: string;
  if (tool === "codex") {
    const base = existing ?? "";
    if (existing !== null && !parsesToml(base)) {
      return { ok: false, path, reason: `${path} is not valid TOML` };
    }
    text = mergeTomlMcp(base, servers);
  } else {
    let base: unknown = {};
    if (existing !== null) {
      try {
        base = existing.trim() === "" ? {} : JSON.parse(existing);
      } catch {
        return { ok: false, path, reason: `${path} is not valid JSON` };
      }
    }
    // A JSON file whose root is an array or a scalar is still "valid JSON" but
    // cannot hold named servers; merging would replace the whole document with
    // one this app generated. Refuse and let the operator fix the file.
    let merged: JsonConfig;
    try {
      merged = mergeMcpConfig(base, tool, servers);
    } catch (error) {
      return {
        ok: false,
        path,
        reason: `${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    text = `${JSON.stringify(merged, null, 2)}\n`;
  }

  try {
    writeFileAtomically(path, text);
  } catch (error) {
    return { ok: false, path, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, path, count: servers.filter((s) => s.enabled).length };
}

// -- internals ---------------------------------------------------------------

function readOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parsesToml(text: string): boolean {
  try {
    mergeTomlMcp(text, []);
    return true;
  } catch {
    return false;
  }
}
