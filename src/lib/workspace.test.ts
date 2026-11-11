import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath, isWithinRoots } from "./workspace";
import { clearDummyEnv, useDummyEnv } from "../test/dummy-env";

let roots: string;
let inside: string;
let outside: string;

beforeEach(() => {
  useDummyEnv();
  roots = mkdtempSync(join(tmpdir(), "ws-roots-"));
  inside = join(roots, "project");
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, "f.txt"), "x");
  outside = mkdtempSync(join(tmpdir(), "ws-out-"));
  writeFileSync(join(outside, "secret.txt"), "s");
});

afterEach(() => {
  clearDummyEnv();
  rmSync(roots, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("isWithinRoots", () => {
  it("accepts a path inside an allowed root, normalizing traversal", () => {
    expect(
      isWithinRoots([roots], join(inside, "sub", "..", "f.txt")),
    ).toBe(true);
  });

  it("rejects a path outside every root", () => {
    expect(isWithinRoots([roots], join(outside, "secret.txt"))).toBe(false);
  });

  it("rejects the root's parent and prefix-sibling lookalikes", () => {
    // /tmp/ws-roots-attack shares a string prefix with /tmp/ws-roots-xxx
    const lookalike = `${roots}-attack`;
    mkdirSync(lookalike);
    try {
      expect(isWithinRoots([roots], lookalike)).toBe(false);
    } finally {
      rmSync(lookalike, { recursive: true, force: true });
    }
  });

  it("rejects symlink escapes (realpath containment)", () => {
    const link = join(roots, "escape");
    symlinkSync(outside, link);
    try {
      expect(isWithinRoots([roots], link)).toBe(false);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it("rejects absolute and relative traversal that leaves the root", () => {
    expect(isWithinRoots([roots], join(roots, "..", "..", "etc", "passwd"))).toBe(false);
  });
});

describe("resolveWorkspacePath", () => {
  it("returns the contained realpath for a valid cwd", () => {
    const got = resolveWorkspacePath([roots], inside);
    expect(got).toBe(inside);
  });

  it("returns null (not a throw) for escapes — callers render 400", () => {
    expect(resolveWorkspacePath([roots], "/etc")).toBeNull();
    expect(resolveWorkspacePath([roots], join(outside, "secret.txt"))).toBeNull();
  });

  it("returns null for empty roots (feature disabled)", () => {
    expect(resolveWorkspacePath([], inside)).toBeNull();
  });
});
