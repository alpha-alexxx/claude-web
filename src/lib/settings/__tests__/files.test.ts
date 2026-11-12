import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as stringifyToml } from "smol-toml";
import {
  applySettingsWrite,
  readSettingsFile,
  settingsFilePath,
  type ToolSettingsTarget,
} from "../files";
import { REDACTED } from "../redact";

/**
 * Writing a tool's settings file is the most destructive action in this app:
 * it is the operator's own config, often hand-edited, sometimes the only copy.
 * So the write path backs up first, validates before touching anything, and
 * keeps the file's own permissions. These tests exercise all three against a
 * real temp HOME.
 *
 * Two contracts here are easy to get backwards, so they are spelled out:
 *
 *   - A file that does not PARSE is never echoed back. It might hold a secret
 *     the redacting parse would have removed, and there is no safe substring
 *     edit for that. The editor gets `text: ""`, `parsed: false` and a reason.
 *   - A save that changes nothing does not rewrite the file, because
 *     re-serializing drops the operator's comments and formatting.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "settings-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const CLAUDE: ToolSettingsTarget = { tool: "claude", format: "json" };
const CODEX: ToolSettingsTarget = { tool: "codex", format: "toml" };
const OPENCODE: ToolSettingsTarget = { tool: "opencode", format: "json" };
const QODER: ToolSettingsTarget = { tool: "qoder", format: "json" };

describe("settingsFilePath", () => {
  it("points at the file each tool actually reads", () => {
    expect(settingsFilePath(home, "claude")).toBe(join(home, ".claude", "settings.json"));
    expect(settingsFilePath(home, "codex")).toBe(join(home, ".codex", "config.toml"));
    expect(settingsFilePath(home, "opencode")).toBe(
      join(home, ".config", "opencode", "opencode.json"),
    );
    expect(settingsFilePath(home, "qoder")).toBe(join(home, ".qoder", "settings.json"));
  });

  it("reads OpenCode's own settings file, not Claude's", () => {
    const dir = join(home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "x" }));
    expect(readSettingsFile(home, OPENCODE)).toMatchObject({ exists: true, parsed: true });
  });
});

describe("readSettingsFile", () => {
  it("reports a missing file as missing, not an error", () => {
    const result = readSettingsFile(home, CLAUDE);
    expect(result).toMatchObject({ exists: false, text: "", value: {}, parsed: true });
  });

  it("redacts secrets on the way out", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ model: "opus", env: { ANTHROPIC_API_KEY: "sk-live" } }),
    );

    const result = readSettingsFile(home, CLAUDE);
    expect(result.exists).toBe(true);
    expect(result.parsed).toBe(true);
    const value = result.value as { env: Record<string, string> };
    expect(value.env.ANTHROPIC_API_KEY).toBe(REDACTED);
    // The TEXT handed to the editor is redacted too — the value must not be in
    // the response body at all.
    expect(result.text).not.toContain("sk-live");
  });

  it("parses TOML and redacts it", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.toml"),
      stringifyToml({ model: "gpt-5", mcp_servers: { s: { env: { GITHUB_TOKEN: "ghp_x" } } } }),
    );

    const result = readSettingsFile(home, CODEX);
    expect(result.parsed).toBe(true);
    expect(result.text).not.toContain("ghp_x");
    expect(result.text).toContain("GITHUB_TOKEN");
  });

  it("returns a clean file's own text, so comments survive a round trip", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    const original = '# my notes\nmodel = "gpt-5"\n';
    writeFileSync(join(dir, "config.toml"), original);

    expect(readSettingsFile(home, CODEX).text).toBe(original);
  });

  it("reports a parse failure with a reason and no text", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), '{"broken":');

    const result = readSettingsFile(home, CLAUDE);
    expect(result.exists).toBe(true);
    expect(result.parsed).toBe(false);
    expect(result.message).toMatch(/JSON/i);
  });

  it("does not echo a file it cannot parse, even when it holds a secret", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      '{"env": {"ANTHROPIC_API_KEY": "sk-live"}, "broken":',
    );

    const result = readSettingsFile(home, CLAUDE);
    expect(result.parsed).toBe(false);
    expect(result.text).toBe("");
    expect(result.message).not.toContain("sk-live");
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });
});

describe("applySettingsWrite", () => {
  it("writes a new file atomically with 0600", () => {
    const result = applySettingsWrite(home, CLAUDE, '{"model":"opus"}');
    expect(result.ok).toBe(true);
    const file = settingsFilePath(home, "claude");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "opus" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("creates the tool's directory if absent", () => {
    expect(applySettingsWrite(home, QODER, '{"a":1}').ok).toBe(true);
    expect(existsSync(join(home, ".qoder", "settings.json"))).toBe(true);
  });

  it("backs up the previous file before overwriting", () => {
    applySettingsWrite(home, CLAUDE, '{"model":"opus"}');
    const result = applySettingsWrite(home, CLAUDE, '{"model":"sonnet"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backup).toBeTruthy();
    expect(JSON.parse(readFileSync(result.backup!, "utf8"))).toEqual({ model: "opus" });
  });

  it("refuses invalid JSON and leaves the file untouched", () => {
    applySettingsWrite(home, CLAUDE, '{"model":"opus"}');
    const result = applySettingsWrite(home, CLAUDE, '{"model":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JSON/i);
    expect(JSON.parse(readFileSync(settingsFilePath(home, "claude"), "utf8"))).toEqual({
      model: "opus",
    });
  });

  it("refuses invalid TOML", () => {
    const result = applySettingsWrite(home, CODEX, "not = [toml");
    expect(result.ok).toBe(false);
    expect(existsSync(settingsFilePath(home, "codex"))).toBe(false);
  });

  it("refuses to write over a stored file that does not parse", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"model":');

    const result = applySettingsWrite(home, CLAUDE, '{"model":"opus"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stored_unparseable");
    expect(readFileSync(file, "utf8")).toBe('{"model":');
  });

  it("preserves a stored secret when the marker is posted back", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-live" } }));

    // This is exactly what the editor sends after a redacted read.
    const result = applySettingsWrite(
      home,
      CLAUDE,
      JSON.stringify({ env: { ANTHROPIC_API_KEY: REDACTED } }),
    );
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      env: { ANTHROPIC_API_KEY: "sk-live" },
    });
  });

  it("does not rewrite a file when the save changed nothing", () => {
    const dir = join(home, ".codex");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "config.toml");
    const original = '# hand-written, keep me\nmodel = "gpt-5"\n';
    writeFileSync(file, original);

    const result = applySettingsWrite(home, CODEX, original);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.backup).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirNames(dir)).toEqual(["config.toml"]);
  });

  it("keeps the file's existing permissions rather than widening them", () => {
    const dir = join(home, ".claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "settings.json");
    writeFileSync(file, '{"model":"opus"}', { mode: 0o640 });

    applySettingsWrite(home, CLAUDE, '{"a":1}');
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("does not leave temp files behind", () => {
    applySettingsWrite(home, CLAUDE, '{"a":1}');
    expect(readdirNames(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  it("writes through a symlinked settings file instead of replacing the link", () => {
    // Operators commonly keep ~/.claude/settings.json as a symlink into a
    // dotfiles repo. `rename` over the link would replace it with a regular
    // file and silently detach it from that repo.
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const target = join(dotfiles, "claude-settings.json");
    writeFileSync(target, '{"model":"opus"}\n');

    mkdirSync(join(home, ".claude"), { recursive: true });
    const link = join(home, ".claude", "settings.json");
    symlinkSync(target, link);

    const result = applySettingsWrite(home, CLAUDE, '{"model":"sonnet"}');
    expect(result.ok).toBe(true);

    // The link is still a link, and the content landed on its target.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ model: "sonnet" });
    // Nothing staged into the link's directory: the temp file was created
    // beside the resolved target so the rename stayed on one filesystem.
    expect(readdirNames(join(home, ".claude"))).toEqual(["settings.json"]);
    expect(readdirNames(dotfiles).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("creates the target of a dangling symlink rather than clobbering the link", () => {
    const dotfiles = join(home, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const link = join(home, ".claude", "settings.json");
    // Relative link text, the usual dotfiles-repo form.
    symlinkSync("../dotfiles/claude-settings.json", link);

    const result = applySettingsWrite(home, CLAUDE, '{"model":"opus"}');
    expect(result.ok).toBe(true);

    const target = join(dotfiles, "claude-settings.json");
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ model: "opus" });
  });

  it("ends the file with a newline", () => {
    applySettingsWrite(home, CODEX, 'model = "gpt-5"');
    expect(readFileSync(settingsFilePath(home, "codex"), "utf8").endsWith("\n")).toBe(true);
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
