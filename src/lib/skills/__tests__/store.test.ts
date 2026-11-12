import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalSkillsDir,
  ensureSkillsStore,
  ensureSkillsView,
  listSkills,
  skillToolDir,
  skillsView,
  syncSkillToTool,
  unsyncSkillFromTool,
} from "../store";

/**
 * The skills store is a real directory tree on the operator's home, shared with
 * four tools that read four different paths. These tests run against a temp
 * HOME so every filesystem claim is actually exercised — including the ones
 * that matter most: never replacing a real directory with a symlink, and never
 * following a slug out of the store.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skills-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeSkill(slug: string, frontmatter: string, body = "# Body\n") {
  const dir = join(canonicalSkillsDir(home), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `${frontmatter}\n${body}`);
  return dir;
}

describe("paths", () => {
  it("puts the canonical store under .agents/skills", () => {
    expect(canonicalSkillsDir(home)).toBe(join(home, ".agents", "skills"));
  });

  it("maps each tool to the path it actually reads", () => {
    // Codex and OpenCode read ~/.agents/skills natively, so the canonical
    // store IS their skills directory. Claude needs a symlink; Qoder gets a
    // managed directory of per-skill symlinks.
    expect(skillToolDir(home, "codex")).toBe(join(home, ".agents", "skills"));
    expect(skillToolDir(home, "opencode")).toBe(join(home, ".agents", "skills"));
    expect(skillToolDir(home, "claude")).toBe(join(home, ".claude", "skills"));
    expect(skillToolDir(home, "qoder")).toBe(join(home, ".qoder", "skills"));
  });
});

describe("ensureSkillsStore", () => {
  it("creates the canonical store 0700 on first run", () => {
    const result = ensureSkillsStore(home);
    expect(result.canonicalCreated).toBe(true);
    expect(result.claude).toBe("linked");
  });

  it("creates .claude/skills as a symlink to the canonical store", () => {
    ensureSkillsStore(home);
    const link = skillToolDir(home, "claude");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(canonicalSkillsDir(home));
  });

  it("creates a missing .claude directory instead of failing", () => {
    expect(() => ensureSkillsStore(home)).not.toThrow();
    expect(lstatSync(join(home, ".claude")).isDirectory()).toBe(true);
  });

  it("is idempotent", () => {
    ensureSkillsStore(home);
    const second = ensureSkillsStore(home);
    expect(second.canonicalCreated).toBe(false);
    expect(second.claude).toBe("linked");
  });

  it("never replaces a real ~/.claude/skills directory; it reports a conflict", () => {
    const real = join(home, ".claude", "skills");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "keep.md"), "user data");
    const result = ensureSkillsStore(home);
    expect(result.claude).toBe("conflict");
    expect(lstatSync(real).isSymbolicLink()).toBe(false);
    // The canonical store is still empty, so the operator's own files were not
    // adopted as skills.
    expect(listSkills(home)).toEqual([]);
  });

  it("treats a link to somewhere else as a conflict, not as ours to replace", () => {
    // The operator may already point ~/.claude/skills at their own tree.
    // Only a link to the canonical store counts as "already bridged".
    const other = join(home, "other-skills");
    mkdirSync(other, { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    const link = skillToolDir(home, "claude");
    symlinkSync(other, link, "dir");

    expect(ensureSkillsStore(home).claude).toBe("conflict");
    expect(readlinkSync(link)).toBe(other);
  });

  it("leaves ~/.qoder alone until a skill is actually synced", () => {
    ensureSkillsStore(home);
    expect(() => lstatSync(join(home, ".qoder"))).toThrow();
  });
});

describe("an unusable filesystem", () => {
  // `~/.claude` and `~/.qoder` are operator-editable paths, and a home
  // directory can be read-only. The store promises `{ ok:false, reason }` at
  // every request boundary, so an ENOTDIR from a file where a directory
  // belongs has to come back as a reason the page can show — not as a thrown
  // error that turns the whole Skills page into a 500.

  it("reports an unusable store instead of throwing when ~/.agents is a file", () => {
    writeFileSync(join(home, ".agents"), "not a directory");
    const result = ensureSkillsStore(home);
    expect(result.claude).toBe("unavailable");
    expect(result.error).toMatch(/ENOTDIR/);
  });

  it("reports a ~/.claude that cannot be created", () => {
    writeFileSync(join(home, ".claude"), "not a directory");
    const result = ensureSkillsStore(home);
    expect(result.claude).toBe("unavailable");
    expect(result.error).toMatch(/EEXIST/);
  });

  it("carries that failure into the view instead of rendering an empty store", () => {
    writeFileSync(join(home, ".agents"), "not a directory");
    const view = ensureSkillsView(home);
    expect(view.storeError).toMatch(/ENOTDIR/);
    expect(view.skills).toEqual([]);
  });

  it("refuses a qoder link rather than throwing when its directory is a file", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    writeFileSync(join(home, ".qoder"), "not a directory");
    const result = syncSkillToTool(home, "alpha", "qoder");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ENOTDIR/);
  });

  it("refuses a claude link with the store's own reason", () => {
    writeSkill("alpha", "---\nname: Alpha\n---");
    writeFileSync(join(home, ".claude"), "not a directory");
    const result = syncSkillToTool(home, "alpha", "claude");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\.claude/);
  });

  it("reports a healthy store as error-free", () => {
    const result = ensureSkillsStore(home);
    expect(result.error).toBeNull();
    expect(ensureSkillsView(home).storeError).toBeNull();
  });
});

describe("listSkills", () => {
  it("lists skills by directory, using frontmatter for display", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\ndescription: Does alpha things\n---");
    writeSkill("beta", "---\ndescription: no name here\n---");

    const skills = listSkills(home);
    expect(skills.map((skill) => skill.slug)).toEqual(["alpha", "beta"]);
    expect(skills[0]).toMatchObject({
      slug: "alpha",
      name: "Alpha",
      description: "Does alpha things",
      malformed: false,
    });
    expect(skills[1]).toMatchObject({ slug: "beta", name: "beta", malformed: true });
  });

  it("returns empty when the store does not exist yet", () => {
    expect(listSkills(home)).toEqual([]);
  });

  it("ignores files, dotfiles and directories with no SKILL.md", () => {
    const store = canonicalSkillsDir(home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "loose.md"), "x");
    mkdirSync(join(store, ".cache"));
    mkdirSync(join(store, "empty"));
    expect(listSkills(home)).toEqual([]);
  });

  it("sorts by name so the page is stable", () => {
    ensureSkillsStore(home);
    writeSkill("z", "---\nname: zebra\n---");
    writeSkill("a", "---\nname: apple\n---");
    expect(listSkills(home).map((s) => s.name)).toEqual(["apple", "zebra"]);
  });
});

describe("syncSkillToTool / unsyncSkillFromTool", () => {
  it("symlinks one skill into ~/.qoder/skills", () => {
    ensureSkillsStore(home);
    const source = writeSkill("alpha", "---\nname: Alpha\n---");
    expect(syncSkillToTool(home, "alpha", "qoder")).toEqual({ ok: true });

    const target = join(skillToolDir(home, "qoder"), "alpha");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readlinkSync(target)).toBe(source);
  });

  it("is idempotent", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    syncSkillToTool(home, "alpha", "qoder");
    expect(syncSkillToTool(home, "alpha", "qoder")).toEqual({ ok: true });
  });

  it("refuses to clobber a real directory the operator made", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    const target = join(skillToolDir(home, "qoder"), "alpha");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "mine.md"), "x");

    const result = syncSkillToTool(home, "alpha", "qoder");
    if (result.ok) throw new Error("expected the sync to refuse");
    expect(result.reason).toMatch(/exists/i);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
  });

  it("reports a missing skill rather than linking nothing", () => {
    ensureSkillsStore(home);
    const result = syncSkillToTool(home, "ghost", "qoder");
    if (result.ok) throw new Error("expected the sync to refuse");
    expect(result.reason).toMatch(/not found/i);
  });

  it("rejects a traversal slug", () => {
    ensureSkillsStore(home);
    expect(syncSkillToTool(home, "../etc", "qoder").ok).toBe(false);
  });

  it("unlinks a managed symlink but never deletes a real directory", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    syncSkillToTool(home, "alpha", "qoder");
    expect(unsyncSkillFromTool(home, "alpha", "qoder")).toEqual({ ok: true });
    expect(() => lstatSync(join(skillToolDir(home, "qoder"), "alpha"))).toThrow();

    const manual = join(skillToolDir(home, "qoder"), "manual");
    mkdirSync(manual, { recursive: true });
    const refused = unsyncSkillFromTool(home, "manual", "qoder");
    expect(refused.ok).toBe(false);
    expect(lstatSync(manual).isDirectory()).toBe(true);
  });

  it("leaves a symlink the operator made to their own tree alone", () => {
    // Sync already refuses a foreign link, so the only way one exists at the
    // target is that the operator put it there. Removing it because a button
    // says "unsync" would delete a link this app never created.
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    const operator = join(home, "operator-skills", "alpha");
    mkdirSync(operator, { recursive: true });
    writeFileSync(join(operator, "SKILL.md"), "---\nname: Alpha\n---");
    const target = join(skillToolDir(home, "qoder"), "alpha");
    mkdirSync(skillToolDir(home, "qoder"), { recursive: true });
    symlinkSync(operator, target, "dir");

    const result = unsyncSkillFromTool(home, "alpha", "qoder");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not managed/i);
    expect(readlinkSync(target)).toBe(operator);
  });
});

describe("skillsView", () => {
  it("labels each tool's availability", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");

    const view = skillsView(home);
    expect(view.storePath).toBe(canonicalSkillsDir(home));
    expect(view.tools.map((entry) => [entry.tool, entry.mode, entry.state])).toEqual([
      ["claude", "symlink", "ready"],
      ["codex", "native", "ready"],
      ["opencode", "native", "ready"],
      ["qoder", "managed", "needs_sync"],
    ]);

    const skill = view.skills[0];
    expect(skill.tools.qoder).toBe("missing");
    expect(skill.tools.codex).toBe("synced");
  });

  it("reports claude as a conflict when the directory is real", () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const view = skillsView(home);
    const claude = view.tools.find((entry) => entry.tool === "claude");
    expect(claude?.state).toBe("conflict");
  });

  it("marks a skill synced to qoder once linked", () => {
    ensureSkillsStore(home);
    writeSkill("alpha", "---\nname: Alpha\n---");
    syncSkillToTool(home, "alpha", "qoder");
    expect(skillsView(home).skills[0].tools.qoder).toBe("synced");
  });
});
