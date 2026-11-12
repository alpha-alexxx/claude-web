/**
 * SKILL.md frontmatter — the one cross-tool contract in the skills store.
 *
 * Deliberately a hand-written parser rather than a YAML dependency: skills
 * declare a flat `name`/`description` pair (agentskills.io), the file is
 * authored by humans, and a parser that THROWS on a malformed file would make
 * a skill disappear from the browser with no explanation. Everything here is
 * total — bad input degrades to the directory name and a `malformed` flag, so
 * the operator sees the skill and learns the file needs fixing.
 */

/** Parsed SKILL.md: frontmatter keys and the markdown body after it. */
export interface ParsedSkillText {
  data: Record<string, string>;
  body: string;
}

/**
 * Split a SKILL.md into frontmatter and body. Only a `---` on the FIRST line
 * opens frontmatter; an unterminated block is not frontmatter at all (the file
 * is then all body), which matches how the agentskills readers treat it.
 */
export function parseFrontmatter(text: string): ParsedSkillText {
  const source = text.replace(/^﻿/, "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: source };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: source };

  const data: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    // Keys are plain identifiers in practice; skipping anything else keeps
    // nested YAML (which no SKILL.md declares) from producing junk keys.
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    data[key] = unquote(trimmed.slice(colon + 1).trim());
  }

  return { data, body: lines.slice(end + 1).join("\n") };
}

/** One skill as the browser sees it. */
export interface SkillFile {
  /** Directory name — the stable identity, even when `name` is prettier. */
  slug: string;
  /** Declared `name`, or the slug when absent. */
  name: string;
  description: string | null;
  /** True when there is no usable frontmatter (no `name` key). */
  malformed: boolean;
}

/**
 * Read one skill from its directory name and SKILL.md contents. A skill is
 * "malformed" only when it declares no `name`; a missing `description` is
 * common and merely less useful, not broken.
 */
export function parseSkillFile(slug: string, text: string): SkillFile {
  const { data } = parseFrontmatter(text);
  const declared = data.name?.trim();
  return {
    slug,
    name: declared && declared.length > 0 ? declared : slug,
    description: data.description?.trim() || null,
    malformed: !declared,
  };
}

/**
 * The store's naming rule for a skill directory. Returning null (rather than
 * throwing) lets callers turn a bad name into a 400 without a try/catch, and
 * rejecting a leading dot or a separator is what stops a request from naming
 * a path outside the store.
 */
export function skillSlug(raw: string): string | null {
  if (raw.length === 0 || raw.length > 64) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw) ? raw : null;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
