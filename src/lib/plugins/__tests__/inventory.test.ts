import { describe, expect, it } from "vitest";
import {
  parseClaudePluginList,
  pluginCompat,
  unifiedPlugins,
  type PluginManifestSet,
} from "../inventory";

/**
 * Plugins are the least portable thing in this app: four incompatible manifest
 * conventions, and no tool reads another's. So the manager's job is limited to
 * what is honestly knowable — list what each CLI reports, label which tools
 * COULD read it, and route install/uninstall to the owning CLI. These tests pin
 * that honesty: an unknown manifest never claims compatibility.
 */

const CLAUDE_JSON = JSON.stringify([
  {
    id: "frontend-design@anthropic-plugin-directory",
    version: "1.1.1-43fd1f9db094",
    scope: "user",
    enabled: true,
    installPath: "/home/u/.claude/plugins/cache/anthropic-plugin-directory/frontend-design/1.1.1",
    installedAt: "2026-01-02T03:04:05.000Z",
    lastUpdated: "2026-02-02T03:04:05.000Z",
    projectEnabled: {},
  },
  {
    id: "superpowers@anthropic-plugin-directory",
    version: "2.0.0",
    scope: "user",
    enabled: false,
    installPath: "/home/u/.claude/plugins/cache/anthropic-plugin-directory/superpowers/2.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    lastUpdated: "2026-01-01T00:00:00.000Z",
  },
]);

describe("parseClaudePluginList", () => {
  it("parses the CLI's JSON array", () => {
    const plugins = parseClaudePluginList(CLAUDE_JSON);
    expect(plugins).toHaveLength(2);
    expect(plugins[0]).toMatchObject({
      name: "frontend-design",
      marketplace: "anthropic-plugin-directory",
      version: "1.1.1-43fd1f9db094",
      scope: "user",
      enabled: true,
      provider: "claude",
    });
  });

  it("accepts an already-parsed array", () => {
    expect(parseClaudePluginList(JSON.parse(CLAUDE_JSON))).toHaveLength(2);
  });

  it("returns [] for empty output, junk, or a non-array", () => {
    expect(parseClaudePluginList("")).toEqual([]);
    expect(parseClaudePluginList("not json")).toEqual([]);
    expect(parseClaudePluginList("{}")).toEqual([]);
    expect(parseClaudePluginList("[]")).toEqual([]);
  });

  it("skips entries with no usable id rather than inventing one", () => {
    const out = parseClaudePluginList(
      JSON.stringify([{ version: "1" }, { id: 42 }, { id: "ok@p" }]),
    );
    expect(out.map((plugin) => plugin.id)).toEqual(["ok@p"]);
  });

  it("splits id into name and marketplace, handling a bare name", () => {
    const [bare] = parseClaudePluginList(JSON.stringify([{ id: "solo" }]));
    expect(bare.name).toBe("solo");
    expect(bare.marketplace).toBeNull();
  });

  it("never surfaces a field it does not control as a path", () => {
    // installPath is informational only: the manager drives the CLI, it does
    // not read inside these directories.
    const [plugin] = parseClaudePluginList(CLAUDE_JSON);
    expect(plugin.installPath).toContain("/.claude/plugins/cache/");
  });
});

describe("pluginCompat", () => {
  it("labels a Claude manifest as Claude-only", () => {
    const manifests: PluginManifestSet = { claude: true };
    expect(pluginCompat(manifests)).toEqual(["claude"]);
  });

  it("labels a portable Codex plugin", () => {
    expect(pluginCompat({ codex: true })).toEqual(["codex"]);
  });

  it("lists every tool whose manifest convention is present", () => {
    expect(pluginCompat({ claude: true, qoder: true }).sort()).toEqual([
      "claude",
      "qoder",
    ]);
  });

  it("claims nothing for an unknown layout", () => {
    expect(pluginCompat({})).toEqual([]);
  });
});

describe("unifiedPlugins", () => {
  const manifestsFor = (): PluginManifestSet => ({ claude: true });

  it("merges claude's list with compat labels", () => {
    const unified = unifiedPlugins({
      claude: parseClaudePluginList(CLAUDE_JSON),
      manifestsFor,
    });
    expect(unified).toHaveLength(2);
    expect(unified[0]).toMatchObject({
      name: "frontend-design",
      provider: "claude",
      compatibleWith: ["claude"],
    });
  });

  it("includes providers that reported nothing as an empty list", () => {
    const unified = unifiedPlugins({ claude: [], manifestsFor });
    expect(unified).toEqual([]);
  });

  it("sorts by name then provider so the table is stable", () => {
    const list = parseClaudePluginList(
      JSON.stringify([{ id: "zeta@m" }, { id: "alpha@m" }]),
    );
    const unified = unifiedPlugins({ claude: list, manifestsFor });
    expect(unified.map((plugin) => plugin.name)).toEqual(["alpha", "zeta"]);
  });

  it("surfaces an enabled flag per plugin, not per provider", () => {
    const unified = unifiedPlugins({
      claude: parseClaudePluginList(CLAUDE_JSON),
      manifestsFor,
    });
    expect(unified.find((p) => p.name === "superpowers")?.enabled).toBe(false);
  });
});
