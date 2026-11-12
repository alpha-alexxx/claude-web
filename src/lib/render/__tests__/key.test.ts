import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRenderKey, renderKeyPath, resetRenderKeyForTest } from "../key";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-key-"));
  resetRenderKeyForTest();
});

afterEach(() => {
  resetRenderKeyForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadRenderKey", () => {
  it("creates a 32-byte key at 0600 beside the database, once", () => {
    const dbPath = path.join(tmpDir, "data", "app.db");
    const first = loadRenderKey(dbPath);
    expect(first).toHaveLength(32);
    const file = renderKeyPath(dbPath);
    expect(file).toBe(path.join(tmpDir, "data", "render.key"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    // Second call is the cached value; a fresh process re-reads the same bytes.
    expect(loadRenderKey(dbPath).equals(first)).toBe(true);
    resetRenderKeyForTest();
    expect(loadRenderKey(dbPath).equals(first)).toBe(true);
  });

  it("re-reads an existing key rather than minting a second one (the EEXIST race)", () => {
    const dbPath = path.join(tmpDir, "app.db");
    const existing = Buffer.alloc(32, 7);
    fs.writeFileSync(renderKeyPath(dbPath), existing, { mode: 0o600 });
    expect(loadRenderKey(dbPath).equals(existing)).toBe(true);
  });

  it("refuses a truncated key file instead of signing with it", () => {
    const dbPath = path.join(tmpDir, "app.db");
    fs.writeFileSync(renderKeyPath(dbPath), Buffer.alloc(8, 1), { mode: 0o600 });
    expect(() => loadRenderKey(dbPath)).toThrow(/8 bytes, expected 32/);
  });

  it("keeps separate keys for separate data directories", () => {
    const a = loadRenderKey(path.join(tmpDir, "a", "app.db"));
    const b = loadRenderKey(path.join(tmpDir, "b", "app.db"));
    expect(a.equals(b)).toBe(false);
  });
});
