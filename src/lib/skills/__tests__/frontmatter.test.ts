import { describe, expect, it } from "vitest";
import { parseSkillFile, parseFrontmatter, skillSlug } from "../frontmatter";

/**
 * SKILL.md frontmatter is the one cross-tool contract in the skills store
 * (agentskills.io). The parser is deliberately tiny and total: a skill with
 * broken frontmatter must still be LISTED (its directory name is the
 * fallback), because hiding it would make the store look emptier than it is
 * and the operator would never learn the file is malformed.
 */

describe("parseFrontmatter", () => {
  it("reads simple key/value pairs", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: demo\ndescription: Does a thing\n---\n# Demo\n",
    );
    expect(data).toEqual({ name: "demo", description: "Does a thing" });
    expect(body).toBe("# Demo\n");
  });

  it("strips quotes and handles CRLF", () => {
    const { data } = parseFrontmatter(
      '---\r\nname: "demo"\r\ndescription: \'single\'\r\n---\r\nbody\r\n',
    );
    expect(data.name).toBe("demo");
    expect(data.description).toBe("single");
  });

  it("treats a file with no frontmatter as all body", () => {
    expect(parseFrontmatter("# Just markdown\n")).toEqual({
      data: {},
      body: "# Just markdown\n",
    });
  });

  it("ignores comments and lines that are not key: value", () => {
    const { data } = parseFrontmatter(
      "---\n# comment\nname: demo\nnot a pair\n---\n",
    );
    expect(data).toEqual({ name: "demo" });
  });

  it("never throws on unterminated frontmatter", () => {
    const out = parseFrontmatter("---\nname: demo\n");
    expect(out.data).toEqual({});
    expect(out.body).toContain("name: demo");
  });
});

describe("parseSkillFile", () => {
  it("falls back to the directory name when name is absent", () => {
    const skill = parseSkillFile("my-skill", "---\ndescription: hi\n---\n");
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("hi");
  });

  it("prefers the declared name for display but keeps the slug", () => {
    const skill = parseSkillFile("dir-name", "---\nname: Pretty Name\n---\n");
    expect(skill.name).toBe("Pretty Name");
    expect(skill.slug).toBe("dir-name");
  });

  it("marks a file with no frontmatter", () => {
    const skill = parseSkillFile("bare", "# Bare\n");
    expect(skill.description).toBeNull();
    expect(skill.malformed).toBe(true);
  });

  it("accepts a frontmatter with name but no description", () => {
    const skill = parseSkillFile("x", "---\nname: x\n---\n");
    expect(skill.malformed).toBe(false);
    expect(skill.description).toBeNull();
  });
});

describe("skillSlug", () => {
  it("accepts the store's naming rule", () => {
    expect(skillSlug("my-skill")).toBe("my-skill");
    expect(skillSlug("a.b_c-d")).toBe("a.b_c-d");
  });

  it("rejects traversal and separators", () => {
    for (const bad of ["../etc", "a/b", ".hidden", "", "a b", "-lead"]) {
      expect(skillSlug(bad)).toBeNull();
    }
  });
});
