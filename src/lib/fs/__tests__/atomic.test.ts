import {
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
import { modeFor, resolveWritePath, writeFileAtomically } from "../atomic";

/**
 * One write helper for every file this app replaces. The properties that matter
 * are the ones a plain `writeFile` gets wrong: the old bytes survive a crash,
 * the operator's mode is kept, and a symlinked config stays a symlink.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-fs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomically", () => {
  it("writes a new file 0600 and leaves no temp file behind", () => {
    const file = join(dir, "nested", "new.json");
    writeFileAtomically(file, "{}\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("{}\n");
    expect(readdirSync(join(dir, "nested"))).toEqual(["new.json"]);
  });

  it("keeps an existing file's mode", () => {
    const file = join(dir, "existing.json");
    writeFileSync(file, "old", { mode: 0o640 });
    writeFileAtomically(file, "new");
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it("honours an explicit mode over the destination's", () => {
    const file = join(dir, "secret.env");
    writeFileSync(file, "old", { mode: 0o644 });
    writeFileAtomically(file, "new", { mode: 0o600 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("follows a symlink and leaves the link itself untouched", () => {
    const target = join(dir, "target.json");
    writeFileSync(target, "old");
    const link = join(dir, "link.json");
    symlinkSync(target, link);

    writeFileAtomically(link, "new");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("new");
    // The temp file was created beside the target, not beside the link.
    expect(readdirSync(dir).sort()).toEqual(["link.json", "target.json"]);
  });

  it("creates the target of a dangling link instead of replacing the link", () => {
    const link = join(dir, "link.json");
    symlinkSync("later/target.json", link);

    writeFileAtomically(join(dir, "link.json"), "new");

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, "later", "target.json"), "utf8")).toBe("new");
  });

  it("fails loudly when the destination is a directory", () => {
    const path = join(dir, "dir.json");
    mkdirSync(path);
    expect(() => writeFileAtomically(path, "x")).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
  });
});

describe("resolveWritePath", () => {
  it("returns a missing path unchanged and resolves a link's target", () => {
    expect(resolveWritePath(join(dir, "missing"))).toBe(join(dir, "missing"));
    const target = join(dir, "real");
    writeFileSync(target, "");
    const link = join(dir, "alias");
    symlinkSync(target, link);
    expect(resolveWritePath(link)).toBe(target);
  });
});

describe("modeFor", () => {
  it("reports the file's mode, and 0600 for anything absent", () => {
    const file = join(dir, "m");
    writeFileSync(file, "", { mode: 0o640 });
    expect(modeFor(file)).toBe(0o640);
    expect(modeFor(join(dir, "absent"))).toBe(0o600);
  });
});
