import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearDummyEnv, useDummyEnv } from "../../../test/dummy-env";
import { resetClaudeAdapterForTest } from "../claude/adapter";
import { getAdapter, listAdapters } from "../registry";

beforeEach(() => {
  useDummyEnv();
  resetClaudeAdapterForTest();
});

afterEach(() => {
  clearDummyEnv();
  resetClaudeAdapterForTest();
});

describe("provider registry", () => {
  it("lists only enabled providers, each with id and capabilities", () => {
    const adapters = listAdapters();
    for (const a of adapters) {
      expect(typeof a.id).toBe("string");
      expect(a.capabilities).toBeDefined();
    }
    expect(adapters.map((a) => a.id)).toContain("claude");
  });

  it("returns the claude adapter, which knows its capability set", () => {
    const claude = getAdapter("claude");
    expect(claude).not.toBeNull();
    // Claude is the only provider with a per-call interactive gate today.
    expect(claude!.capabilities.interactiveToolPrompts).toBe(true);
    expect(claude!.capabilities.sessionResume).toBe(true);
    expect(claude!.capabilities.partialText).toBe(true);
    expect(claude!.capabilities.skills).toBe("native");
    expect(claude!.capabilities.plugins).toBe(true);
  });

  it("returns null for an unknown provider id", () => {
    expect(getAdapter("codex" as never)).toBeNull();
  });
});
