import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { readMcpRegistry, syncMcpToTool, writeMcpRegistry } from "../store";
import type { McpServer } from "../registry";

/**
 * The MCP registry is app-owned state (one list of servers) that is then
 * PUSHED into four tools' native config files. Two things must hold:
 *
 *   - the registry is validated on read, so a hand-edited junk entry cannot
 *     reach a tool's config;
 *   - syncing never destroys what the operator wrote themselves. Only the
 *     servers the registry knows about are ours to rewrite.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-store-home-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SERVERS: McpServer[] = [
  { name: "files", command: "npx", args: ["-y", "server-files"], enabled: true },
  { name: "search", command: "node", args: ["search.js"], enabled: true },
];

describe("registry read/write", () => {
  it("treats a missing registry as an empty list", () => {
    expect(readMcpRegistry(dir)).toEqual([]);
  });

  it("round-trips a written registry", () => {
    writeMcpRegistry(dir, SERVERS);
    expect(readMcpRegistry(dir)).toEqual(SERVERS);
  });

  it("writes the registry 0600", () => {
    writeMcpRegistry(dir, SERVERS);
    expect(statSync(join(dir, "mcp-servers.json")).mode & 0o777).toBe(0o600);
  });

  it("creates the directory when absent", () => {
    const nested = join(dir, "data");
    writeMcpRegistry(nested, SERVERS);
    expect(readMcpRegistry(nested)).toHaveLength(2);
  });

  it("drops invalid entries rather than throwing", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(
      join(dir, "data", "mcp-servers.json"),
      JSON.stringify([
        { name: "ok", command: "run" },
        { name: "a b", command: "run" },
        { name: "no-command" },
        "junk",
      ]),
    );
    expect(readMcpRegistry(join(dir, "data"))).toEqual([
      { name: "ok", command: "run", args: [], enabled: true },
    ]);
  });

  it("returns an empty list for unparseable registry JSON", () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "mcp-servers.json"), "{not json");
    expect(readMcpRegistry(join(dir, "data"))).toEqual([]);
  });
});

describe("syncMcpToTool", () => {
  const store = () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeMcpRegistry(join(dir, "data"), SERVERS);
    return join(dir, "data");
  };

  it("writes Claude's mcpServers into ~/.claude.json", () => {
    const result = syncMcpToTool(dir, store(), "claude");
    expect(result.ok).toBe(true);
    const config = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(Object.keys(config.mcpServers)).toEqual(["files", "search"]);
  });

  it("preserves unrelated keys already in ~/.claude.json", () => {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ theme: "dark", mcpServers: {} }));
    syncMcpToTool(dir, store(), "claude");
    const config = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.mcpServers.files).toBeDefined();
  });

  it("writes Codex TOML with [mcp_servers.*] tables", () => {
    const result = syncMcpToTool(dir, store(), "codex");
    expect(result.ok).toBe(true);
    const parsed = parseToml(readFileSync(join(dir, ".codex", "config.toml"), "utf8")) as {
      mcp_servers: Record<string, { command: string }>;
    };
    expect(parsed.mcp_servers.files.command).toBe("npx");
  });

  it("keeps hand-written Codex config around the MCP tables", () => {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '# keep\nmodel = "gpt-5"\n\n[mcp_servers.old]\ncommand = "old"\n',
    );
    syncMcpToTool(dir, store(), "codex");
    const text = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
    expect(text).toContain("# keep");
    expect(text).toContain("old");
  });

  it("writes OpenCode's local-command shape", () => {
    syncMcpToTool(dir, store(), "opencode");
    const config = JSON.parse(
      readFileSync(join(dir, ".config", "opencode", "opencode.json"), "utf8"),
    );
    expect(config.mcp.files).toMatchObject({
      type: "local",
      command: ["npx", "-y", "server-files"],
    });
  });

  it("writes Qoder's mcpServers", () => {
    syncMcpToTool(dir, store(), "qoder");
    const config = JSON.parse(readFileSync(join(dir, ".qoder", "settings.json"), "utf8"));
    expect(config.mcpServers.search.command).toBe("node");
  });

  it("refuses to overwrite a config file it cannot parse", () => {
    writeFileSync(join(dir, ".claude.json"), "{broken");
    const result = syncMcpToTool(dir, store(), "claude");
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, ".claude.json"), "utf8")).toBe("{broken");
  });

  it("refuses a JSON config whose root is an array, leaving it intact", () => {
    // Valid JSON, but not a document that can hold named servers. Replacing it
    // with a generated object would silently discard whatever it held.
    writeFileSync(join(dir, ".claude.json"), '["keep me"]');
    const result = syncMcpToTool(dir, store(), "claude");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected the sync to refuse");
    expect(result.reason).toMatch(/JSON object/);
    expect(readFileSync(join(dir, ".claude.json"), "utf8")).toBe('["keep me"]');
  });

  it("keeps the existing file's permissions", () => {
    writeFileSync(join(dir, ".claude.json"), "{}", { mode: 0o640 });
    syncMcpToTool(dir, store(), "claude");
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o640);
  });

  it("writes a new config file 0600", () => {
    syncMcpToTool(dir, store(), "qoder");
    expect(statSync(join(dir, ".qoder", "settings.json")).mode & 0o777).toBe(0o600);
  });
});
