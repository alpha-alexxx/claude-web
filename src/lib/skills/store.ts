import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, skillSlug, type SkillFile } from "./frontmatter";

/**
 * The shared skills store.
 *
 * SKILL.md is an open standard (agentskills.io) but the four CLIs read four
 * different paths, and none of them reads another's directory. So one canonical
 * tree lives at `~/.agents/skills` — the path Codex reads natively and OpenCode
 * reads as its compat tier — and every other tool is bridged to it:
 *
 *   claude    `~/.claude/skills` -> symlink to the canonical store
 *   qoder     `~/.qoder/skills/<slug>` -> per-skill symlinks (managed)
 *   codex     canonical store, natively
 *   opencode  canonical store, natively
 *
 * The rule throughout is that an operator's real directory is never replaced
 * by a symlink and a real directory is never deleted. Every "cannot" path
 * returns `{ ok: false, reason }` so the page can explain itself; nothing here
 * throws at a request boundary, and nothing follows a slug out of the store.
 */

export type SkillTool = "claude" | "codex" | "opencode" | "qoder";

export type SkillSyncMode = "native" | "symlink" | "managed";

/** Why a tool's skills directory is not usable as-is. */
export type SkillToolState = "ready" | "needs_sync" | "conflict";

export type SkillSyncStatus = "synced" | "missing";

export interface SkillToolView {
  tool: SkillTool;
  mode: SkillSyncMode;
  state: SkillToolState;
  path: string;
}

export interface SkillListItem extends SkillFile {
  /** Per tool: is this skill visible to it right now? */
  tools: Record<SkillTool, SkillSyncStatus>;
}

export interface SkillsView {
  storePath: string;
  /**
   * Why the canonical store could not be read or created, in the filesystem's
   * own words, or null when it is usable. A missing store is not an error — it
   * is an empty store. A store that is a *file*, or a home directory we cannot
   * write to, is: the page says so instead of rendering "no skills yet".
   */
  storeError: string | null;
  tools: SkillToolView[];
  skills: SkillListItem[];
}

export interface EnsureSkillsResult {
  canonicalCreated: boolean;
  /**
   * `conflict` = a real directory is already there; we left it alone.
   * `unavailable` = the store or the link could not be created or inspected at
   * all — `error` says which, in the filesystem's own words.
   */
  claude: "linked" | "conflict" | "unavailable";
  /** Non-null exactly when `claude` is `unavailable`. */
  error: string | null;
}

export type SyncResult = { ok: true } | { ok: false; reason: string };

const TOOLS: SkillTool[] = ["claude", "codex", "opencode", "qoder"];

/** The canonical store. Never `.claude/skills` — Codex does not read that. */
export function canonicalSkillsDir(home: string = homedir()): string {
  return join(home, ".agents", "skills");
}

/** Where a tool looks for skills. Two of the four are the store itself. */
export function skillToolDir(home: string, tool: SkillTool): string {
  switch (tool) {
    case "codex":
    case "opencode":
      return canonicalSkillsDir(home);
    case "claude":
      return join(home, ".claude", "skills");
    case "qoder":
      return join(home, ".qoder", "skills");
  }
}

/**
 * Create the store and bridge Claude to it. Idempotent, and deliberately
 * timid: if `~/.claude/skills` already exists as a real directory the operator
 * put skills there and we report a conflict instead of destroying them.
 * `~/.qoder` is not created here — it appears when a skill is first synced, so
 * "not installed" stays visible in the UI.
 */
export function ensureSkillsStore(home: string = homedir()): EnsureSkillsResult {
  const canonical = canonicalSkillsDir(home);
  const canonicalCreated = !fs.existsSync(canonical);
  try {
    fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
  } catch (err) {
    // `~/.agents` as a regular file, a read-only home, no permission on the
    // parent — all reachable states of an operator-editable path. The page
    // shows the reason; throwing here would 500 the Skills page and the GET.
    return { canonicalCreated: false, claude: "unavailable", error: errorText(err) };
  }

  const claudeDir = join(home, ".claude");
  const claudeSkills = skillToolDir(home, "claude");
  try {
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { canonicalCreated, claude: "unavailable", error: errorText(err) };
  }

  let claude: EnsureSkillsResult["claude"] = "linked";
  const existing = lstatOrNull(claudeSkills);
  if (existing === null) {
    try {
      fs.symlinkSync(canonical, claudeSkills, "dir");
    } catch (err) {
      return { canonicalCreated, claude: "unavailable", error: errorText(err) };
    }
  } else if (!isLinkTo(existing, claudeSkills, canonical)) {
    claude = "conflict";
  }

  return { canonicalCreated, claude, error: null };
}

/**
 * `ensureSkillsStore` plus the read model, for the two callers that render a
 * page. Kept together so a page cannot create the store and then read it
 * without noticing that the creation failed.
 */
export function ensureSkillsView(home: string = homedir()): SkillsView {
  const ensured = ensureSkillsStore(home);
  if (ensured.error !== null) {
    return {
      storePath: canonicalSkillsDir(home),
      storeError: ensured.error,
      tools: [],
      skills: [],
    };
  }
  return skillsView(home);
}

/** Every skill in the store, sorted by display name. Empty if no store yet. */
export function listSkills(home: string = homedir()): SkillFile[] {
  const store = canonicalSkillsDir(home);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillFile[] = [];
  for (const entry of entries) {
    // A symlinked skill directory is legitimate; a dotfile is not a skill.
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const slug = skillSlug(entry.name);
    if (!slug) continue;
    const text = readFileOrNull(join(store, entry.name, "SKILL.md"));
    if (text === null) continue;
    skills.push(parseSkillFile(slug, text));
  }

  return skills.sort((a, b) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
  );
}

/**
 * Link one skill into a tool's managed directory. Refuses to overwrite
 * anything that is not a symlink pointing at the canonical skill, so an
 * operator's own directory with the same name is never destroyed.
 */
export function syncSkillToTool(
  home: string,
  slug: string,
  tool: SkillTool,
): SyncResult {
  const source = storePathFor(home, slug);
  if (source === null || readFileOrNull(join(source, "SKILL.md")) === null) {
    return { ok: false, reason: `Skill "${slug}" not found in the store` };
  }

  if (tool === "codex" || tool === "opencode") {
    return { ok: true }; // Native: already visible, nothing to do.
  }

  const targetDir = skillToolDir(home, tool);

  if (tool === "claude") {
    // A single directory-level symlink covers every skill at once.
    const result = ensureSkillsStore(home);
    if (result.claude === "conflict") {
      return {
        ok: false,
        reason: `${targetDir} already exists as a real directory`,
      };
    }
    if (result.claude === "unavailable") {
      return { ok: false, reason: result.error ?? `Cannot use ${targetDir}` };
    }
    return { ok: true };
  }

  const target = join(targetDir, slug);
  const existing = lstatOrNull(target);
  if (existing !== null) {
    if (isLinkTo(existing, target, source)) return { ok: true };
    return {
      ok: false,
      reason: `${target} already exists and is not managed by this app`,
    };
  }

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(source, target, "dir");
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
  return { ok: true };
}

/**
 * Remove a managed per-skill symlink. A real directory stays: it may hold work
 * the operator did by hand, and losing it to a button labelled "unsync" would
 * be a data loss the UI never warned about. A symlink pointing anywhere but the
 * canonical skill is the operator's too — sync would have refused to make one,
 * so we refuse to remove one.
 */
export function unsyncSkillFromTool(
  home: string,
  slug: string,
  tool: SkillTool,
): SyncResult {
  if (tool === "codex" || tool === "opencode") {
    return { ok: false, reason: "This tool reads the store directly" };
  }
  if (tool === "claude") {
    return {
      ok: false,
      reason: "Claude reads the whole store through one link; there is nothing per-skill to remove",
    };
  }

  const name = skillSlug(slug);
  if (!name) return { ok: false, reason: "Invalid skill name" };

  const source = storePathFor(home, name);
  if (source === null) return { ok: false, reason: "Invalid skill name" };

  const target = join(skillToolDir(home, tool), name);
  const existing = lstatOrNull(target);
  if (existing === null) return { ok: true };
  if (!existing.isSymbolicLink()) {
    return { ok: false, reason: `${target} is a real directory, not a managed link` };
  }
  if (!isLinkTo(existing, target, source)) {
    return {
      ok: false,
      reason: `${target} is a symlink not managed by this app — remove it yourself if it is unwanted`,
    };
  }
  try {
    fs.unlinkSync(target);
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
  return { ok: true };
}

/** The whole read model the Skills page renders — gates resolved here. */
export function skillsView(home: string = homedir()): SkillsView {
  const storePath = canonicalSkillsDir(home);
  const toolStates = buildToolStates(home);
  const skills = listSkills(home).map<SkillListItem>((skill) => ({
    ...skill,
    tools: {
      claude: toolStatus(skill.slug, home, "claude", toolStates),
      codex: toolStatus(skill.slug, home, "codex", toolStates),
      opencode: toolStatus(skill.slug, home, "opencode", toolStates),
      qoder: toolStatus(skill.slug, home, "qoder", toolStates),
    },
  }));

  // A store that exists but cannot be listed is indistinguishable from an empty
  // one in `listSkills`, so ask the filesystem directly.
  const storeError =
    skills.length === 0 && isUnlistable(storePath)
      ? `Cannot read ${storePath}`
      : null;

  return { storePath, storeError, tools: toolStates, skills };
}

// -- internals ---------------------------------------------------------------

function buildToolStates(home: string): SkillToolView[] {
  return TOOLS.map<SkillToolView>((tool) => {
    const path = skillToolDir(home, tool);
    const mode: SkillSyncMode =
      tool === "codex" || tool === "opencode"
        ? "native"
        : tool === "claude"
          ? "symlink"
          : "managed";

    if (mode === "native") return { tool, mode, state: "ready", path };

    const existing = lstatOrNull(path);
    if (mode === "symlink") {
      const state: SkillToolState =
        existing === null || isLinkTo(existing, path, canonicalSkillsDir(home))
          ? "ready"
          : "conflict";
      return { tool, mode, state, path };
    }

    return {
      tool,
      mode,
      state: existing !== null && existing.isDirectory() ? "ready" : "needs_sync",
      path,
    };
  });
}

function toolStatus(
  slug: string,
  home: string,
  tool: SkillTool,
  states: SkillToolView[],
): SkillSyncStatus {
  const state = states.find((entry) => entry.tool === tool);
  if (!state) return "missing";

  if (tool === "codex" || tool === "opencode") return "synced";
  if (tool === "claude") return state.state === "conflict" ? "missing" : "synced";
  // Qoder: managed link exists only if the directory exists AND the link does.
  const target = join(skillToolDir(home, tool), slug);
  const existing = lstatOrNull(target);
  return existing !== null && existing.isSymbolicLink() ? "synced" : "missing";
}

/** Resolve a slug to a directory strictly inside the store, or null. */
function storePathFor(home: string, raw: string): string | null {
  const slug = skillSlug(raw);
  if (slug === null) return null;
  const dir = join(canonicalSkillsDir(home), slug);
  // `skillSlug` already rejects separators and a leading dot; this second
  // check is the cheap belt for a future regex relaxation.
  const store = canonicalSkillsDir(home);
  return dir.startsWith(`${store}/`) ? dir : null;
}

function lstatOrNull(path: string): fs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch {
    return null;
  }
}

function isLinkTo(stat: fs.Stats, path: string, expected: string): boolean {
  if (!stat.isSymbolicLink()) return false;
  try {
    return fs.readlinkSync(path) === expected;
  } catch {
    return false;
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * A store that is a file (ENOTDIR), a dangling link, or a directory we lack
 * permission to list all look like an empty store to `listSkills`. This is the
 * one place that distinguishes them, so the page can say what is wrong.
 */
function isUnlistable(store: string): boolean {
  try {
    fs.readdirSync(store);
    return false;
  } catch (err) {
    // An absent store is the expected first-run state, not a failure.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * The filesystem's own explanation, which names the path and the reason
 * (`ENOTDIR: not a directory, mkdir …`) — the only useful thing to tell an
 * operator whose home directory is in an unexpected state.
 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
