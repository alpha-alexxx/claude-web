import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  generateMcpConfig,
  mcpServerSchema,
  mergeMcpConfig,
  mergeTomlMcp,
  type McpServer,
} from "../registry";

/**
 * One app-owned MCP registry, four incompatible native config shapes. These
 * tests pin the SHAPE each tool reads — they are the contract with the tools,
 * not with our own code, so a change here is a compatibility break.
 */

const FILES: McpServer = {
  name: "files",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
  env: { LOG_LEVEL: "info" },
  enabled: true,
};

const SEARCH: McpServer = {
  name: "search",
  command: "npx",
  args: ["-y", "search-mcp"],
  enabled: true,
};

const SERVERS: McpServer[] = [
  FILES,
  SEARCH,
  { name: "off", command: "npx", args: [], enabled: false },
];

describe("generateMcpConfig — claude", () => {
  it("emits { mcpServers: { name: { command, args, env } } }", () => {
    const config = generateMcpConfig("claude", SERVERS) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(["files", "search"]);
    expect(config.mcpServers.files).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
      env: { LOG_LEVEL: "info" },
    });
  });

  it("omits env when the server declares none", () => {
    const config = generateMcpConfig("claude", SERVERS) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect("env" in config.mcpServers.search).toBe(false);
  });

  it("skips disabled servers — a disabled toggle means absent, not commented", () => {
    const config = generateMcpConfig("claude", SERVERS) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.off).toBeUndefined();
  });

  it("emits an empty object, not null, when everything is disabled", () => {
    expect(generateMcpConfig("claude", [])).toEqual({ mcpServers: {} });
  });
});

describe("generateMcpConfig — codex", () => {
  it("emits TOML that parses back to [mcp_servers.<name>]", () => {
    const text = generateMcpConfig("codex", SERVERS);
    expect(typeof text).toBe("string");
    const parsed = parseToml(text as string) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers.files.command).toBe("npx");
    expect(parsed.mcp_servers.files.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/work",
    ]);
    expect(parsed.mcp_servers.files.env).toEqual({ LOG_LEVEL: "info" });
    expect(parsed.mcp_servers.off).toBeUndefined();
  });

  it("quotes names that TOML would otherwise mangle", () => {
    const text = generateMcpConfig("codex", [
      { name: "my server", command: "run", args: [], enabled: true },
    ]) as string;
    expect(parseToml(text)).toEqual({
      mcp_servers: { "my server": { command: "run", args: [] } },
    });
  });

  it("is valid TOML — an empty registry emits no tables", () => {
    expect(parseToml(generateMcpConfig("codex", []))).toEqual({});
  });
});

describe("generateMcpConfig — opencode", () => {
  it("nests under mcp, not mcpServers", () => {
    const config = generateMcpConfig("opencode", SERVERS) as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(config)).toEqual(["mcp"]);
    expect(config.mcp.files.type).toBe("local");
    expect(config.mcp.files.command).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/work",
    ]);
    expect(config.mcp.files.environment).toEqual({ LOG_LEVEL: "info" });
  });
});

describe("generateMcpConfig — qoder", () => {
  it("uses the mcpServers shape", () => {
    const config = generateMcpConfig("qoder", SERVERS) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.files).toBeDefined();
    expect(config.mcpServers.off).toBeUndefined();
  });
});

describe("mergeMcpConfig", () => {
  it("replaces only the server keys it owns and keeps the rest", () => {
    const existing = {
      theme: "dark",
      mcpServers: { old: { command: "x" }, files: { command: "stale" } },
    };
    const merged = mergeMcpConfig(existing, "claude", SERVERS) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(merged.theme).toBe("dark");
    // Names the registry never heard of are left alone.
    expect(merged.mcpServers.old).toBeDefined();
    // Registry-owned names are authoritative — stale values are replaced.
    expect(merged.mcpServers.files).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
      env: { LOG_LEVEL: "info" },
    });
    expect(merged.mcpServers.search).toBeDefined();
  });

  it("removes a registry server that is now disabled", () => {
    const existing = { mcpServers: { off: { command: "x" }, hand: { command: "y" } } };
    const merged = mergeMcpConfig(existing, "claude", SERVERS) as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.off).toBeUndefined();
    expect(merged.mcpServers.hand).toBeDefined();
  });

  it("does not mutate its input", () => {
    const existing = { mcpServers: { old: { command: "x" } } };
    mergeMcpConfig(existing, "claude", SERVERS);
    expect(existing.mcpServers).toEqual({ old: { command: "x" } });
  });

  it("tolerates a missing section, filling it in", () => {
    expect(
      (mergeMcpConfig(null, "claude", SERVERS) as { mcpServers: object })
        .mcpServers,
    ).toBeDefined();
    expect(
      (
        mergeMcpConfig({ mcpServers: "nope" }, "claude", SERVERS) as {
          mcpServers: object;
        }
      ).mcpServers,
    ).toBeDefined();
  });

  it("refuses a root that is not a JSON object instead of replacing it", () => {
    // `[]`, `"text"` and `42` are valid JSON documents but cannot hold named
    // servers; coercing them to `{}` would delete the file's contents.
    for (const bad of [[], "text", 42, true] as unknown[]) {
      expect(() => mergeMcpConfig(bad, "claude", SERVERS)).toThrow(
        /must be a JSON object/,
      );
    }
  });

  it("refuses to merge TOML config through the JSON path", () => {
    expect(() => mergeMcpConfig({}, "codex", SERVERS)).toThrow(/toml/i);
  });
});

describe("mergeTomlMcp", () => {
  const EXISTING = [
    "# Codex settings — hand written",
    'model = "gpt-5"',
    "",
    "[mcp_servers.old]",
    'command = "old"',
    "",
    "[mcp_servers.files]",
    'command = "stale"',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n");

  it("keeps every non-MCP byte of the file, comments included", () => {
    const out = mergeTomlMcp(EXISTING, SERVERS);
    expect(out).toContain("# Codex settings — hand written");
    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("[profiles.fast]");
    expect(out).toContain('model = "gpt-5-mini"');
  });

  it("replaces registry-owned tables and drops disabled ones", () => {
    const parsed = parseToml(mergeTomlMcp(EXISTING, SERVERS)) as {
      mcp_servers: Record<string, Record<string, unknown>>;
      profiles: Record<string, unknown>;
    };
    expect(parsed.mcp_servers.files.command).toBe("npx");
    expect(parsed.mcp_servers.search).toBeDefined();
    expect(parsed.mcp_servers.off).toBeUndefined();
    // A server the registry never heard of is preserved, not adopted.
    expect(parsed.mcp_servers.old).toBeDefined();
    expect(parsed.profiles).toBeDefined();
  });

  it("is idempotent", () => {
    const once = mergeTomlMcp(EXISTING, SERVERS);
    expect(mergeTomlMcp(once, SERVERS)).toBe(once);
  });

  it("is idempotent for a quoted name containing the separator", () => {
    // smol-toml emits `[mcp_servers."my.server"]` when a name has a dot. Naive
    // segmentation split that on the dot, decided the table was not ours, kept
    // the stale block AND appended the new one — a file Codex's own parser then
    // rejects as a redefinition, leaving the operator to repair it by hand.
    const servers = [{ name: "my.server", command: "run", args: [], enabled: true }];
    const once = mergeTomlMcp('[mcp_servers."my.server"]\ncommand = "stale"\n', servers);
    expect(() => parseToml(once)).not.toThrow();
    const parsed = parseToml(once) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp_servers["my.server"].command).toBe("run");
    expect(mergeTomlMcp(once, servers)).toBe(once);
  });

  it("works on an empty file and on a file with no MCP tables", () => {
    expect(
      (parseToml(mergeTomlMcp("", SERVERS)) as { mcp_servers: object })
        .mcp_servers,
    ).toBeDefined();
    expect(mergeTomlMcp('model = "x"\n', [])).toContain('model = "x"');
  });

  it("refuses to write over a file it cannot parse", () => {
    expect(() => mergeTomlMcp("this is [not toml", SERVERS)).toThrow(/parse/i);
  });
});

describe("mcpServerSchema", () => {
  it("accepts a minimal server and trims the name", () => {
    const parsed = mcpServerSchema.parse({
      name: "  files ",
      command: "npx",
      args: [],
    });
    expect(parsed.name).toBe("files");
    expect(parsed.enabled).toBe(true);
  });

  it("defaults args to [] and rejects a blank name or command", () => {
    expect(mcpServerSchema.parse({ name: "a", command: "c" }).args).toEqual([]);
    expect(mcpServerSchema.safeParse({ name: " ", command: "c" }).success).toBe(
      false,
    );
    expect(mcpServerSchema.safeParse({ name: "a", command: "" }).success).toBe(
      false,
    );
  });

  it("rejects names that break TOML/JSON keys or path safety", () => {
    for (const name of ["a b", "a/b", "..", 'a"b']) {
      expect(mcpServerSchema.safeParse({ name, command: "c" }).success).toBe(
        false,
      );
    }
  });

  it("rejects a non-string in args — argv is never interpolated", () => {
    expect(
      mcpServerSchema.safeParse({ name: "a", command: "c", args: [1] }).success,
    ).toBe(false);
  });
});
