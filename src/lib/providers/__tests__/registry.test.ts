import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearDummyEnv, useDummyEnv } from "../../../test/dummy-env";
import { resetClaudeAdapterForTest } from "../claude/adapter";
import { resetCodexAdapterForTest } from "../codex/adapter";
import { resetOpenCodeAdapterForTest } from "../opencode/adapter";
import { resetQoderAdapterForTest } from "../qoder/adapter";
import { getAdapter, isImplemented, listAdapters } from "../registry";

const ALL = ["claude", "codex", "opencode", "qoder"] as const;

function resetAll(): void {
  resetClaudeAdapterForTest();
  resetCodexAdapterForTest();
  resetOpenCodeAdapterForTest();
  resetQoderAdapterForTest();
}

beforeEach(() => {
  useDummyEnv({ ENABLED_PROVIDERS: ALL.join(",") });
  resetAll();
});

afterEach(() => {
  clearDummyEnv();
  resetAll();
});

describe("provider registry", () => {
  it("implements every provider the UI lists", () => {
    // The failure this pins: an adapter committed but never wired into the
    // registry's dispatch is invisible — enabling the provider yields nothing
    // and the Integrations page reports it unavailable, with no error anywhere.
    for (const id of ALL) {
      expect(isImplemented(id)).toBe(true);
      expect(getAdapter(id)).not.toBeNull();
    }
  });

  it("lists enabled providers in a stable order, each with id and capabilities", () => {
    const adapters = listAdapters();
    expect(adapters.map((a) => a.id)).toEqual([...ALL]);
    for (const a of adapters) {
      expect(typeof a.id).toBe("string");
      expect(a.capabilities).toBeDefined();
    }
  });

  it("returns the claude adapter, which knows its capability set", () => {
    const claude = getAdapter("claude");
    expect(claude).not.toBeNull();
    // Claude is the only provider with a per-call interactive gate.
    expect(claude!.capabilities.interactiveToolPrompts).toBe(true);
    expect(claude!.capabilities.sessionResume).toBe(true);
    expect(claude!.capabilities.partialText).toBe(true);
    expect(claude!.capabilities.skills).toBe("native");
    expect(claude!.capabilities.plugins).toBe(true);
  });

  it("returns the qoder adapter with its own capability set", () => {
    const qoder = getAdapter("qoder");
    expect(qoder).not.toBeNull();
    expect(qoder!.capabilities.interactiveToolPrompts).toBe(false);
    expect(qoder!.capabilities.partialText).toBe(true);
    expect(qoder!.capabilities.skills).toBe("managed");
    expect(qoder!.capabilities.plugins).toBe(false);
  });

  it("refuses a provider that ENABLED_PROVIDERS omits, even though it is implemented", () => {
    useDummyEnv({ ENABLED_PROVIDERS: "claude" });
    expect(getAdapter("codex")).toBeNull();
    expect(getAdapter("qoder")).toBeNull();
    expect(listAdapters().map((a) => a.id)).toEqual(["claude"]);
  });

  it("returns null for an unknown provider id", () => {
    expect(getAdapter("aider" as never)).toBeNull();
  });
});
