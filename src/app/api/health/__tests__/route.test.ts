import { describe, it, expect, vi, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { GET } from "../route";

/**
 * Health route: auth-gated provider inventory, no-store, and no credential
 * values in the payload — only the tri-state `authed` flag.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

vi.mock("@/lib/providers/registry", () => ({
  listAdapters: () => [
    {
      id: "claude",
      capabilities: {
        interactiveToolPrompts: true,
        sessionResume: true,
        partialText: true,
        skills: "native",
        plugins: true,
      },
      inventory: async () => ({
        id: "claude",
        installed: true,
        version: "2.1.322",
        authed: true,
        reason: null,
        models: [{ id: "sonnet", label: "Claude Sonnet" }],
      }),
    },
  ],
  getAdapter: () => null,
  listProviderSummaries: () => [],
}));

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

afterEach(clearDummyEnv);

describe("GET /api/health", () => {
  it("401 unauthenticated", async () => {
    useDummyEnv();
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the provider inventory with no-store", async () => {
    useDummyEnv();
    vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      providers: { id: string; authed: boolean; version: string }[];
    };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: "claude",
      authed: true,
      version: "2.1.322",
    });
    // Credential material must never be in the payload.
    expect(JSON.stringify(body)).not.toMatch(/sk-ant|oauth-token|bearer/i);
  });
});
