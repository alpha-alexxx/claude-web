import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { requireActor } from "@/lib/auth/current-actor";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";
import { GET } from "../route";

/**
 * Bootstrap route: the client's single config-discovery call. It hands the
 * signed-in user everything the chat surface needs on load — allowed cwd
 * roots, provider summaries + models, default model — and nothing else.
 * Env values (gateway URLs, keys) must never appear in the payload.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

const CWD = process.cwd();

const CAPABILITIES = {
  interactiveToolPrompts: true,
  sessionResume: true,
  partialText: true,
  skills: "native",
  plugins: true,
};

vi.mock("@/lib/providers/registry", () => ({
  listAdapters: () => [adapter],
  getAdapter: () => adapter,
  listProviderSummaries: () => [
    { id: "claude", capabilities: CAPABILITIES },
  ],
}));

const adapter = {
  id: "claude",
  capabilities: CAPABILITIES,
  inventory: async () => ({
    id: "claude",
    installed: true,
    version: "2.1.322",
    authed: true,
    reason: null,
    models: [
      { id: "sonnet", label: "Claude Sonnet (balanced)" },
      { id: "auto", label: "Auto (CLI default)" },
    ],
  }),
  startsSession: vi.fn(),
  liveSession: vi.fn(() => null),
};

const AUTH_OK = {
  ok: true,
  user: { id: "user_1", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

beforeEach(() => {
  useDummyEnv({
    ALLOWED_WORKSPACE_ROOTS: `${CWD},/home/ubuntu/projects`,
    DEFAULT_MODEL: "opus",
  });
  vi.mocked(requireActor).mockResolvedValue(AUTH_OK);
});

afterEach(clearDummyEnv);

describe("GET /api/bootstrap", () => {
  it("401 unauthenticated", async () => {
    vi.mocked(requireActor).mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    const res = await GET();
    expect(res.status).toStrictEqual(401);
  });

  it("returns roots, models, default model and provider summary", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as {
      roots: string[];
      defaultModel: string;
      providers: {
        id: string;
        capabilities: Record<string, unknown>;
        models: { id: string; label: string | null }[];
        authed: boolean | null;
        version: string | null;
        installed: boolean;
      }[];
    };
    expect(body.roots).toEqual([CWD, "/home/ubuntu/projects"]);
    expect(body.defaultModel).toBe("opus");
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe("claude");
    expect(body.providers[0].models).toEqual([
      { id: "sonnet", label: "Claude Sonnet (balanced)" },
      { id: "auto", label: "Auto (CLI default)" },
    ]);
    expect(body.providers[0].capabilities).toMatchObject({
      interactiveToolPrompts: true,
    });
    expect(body.providers[0].authed).toBe(true);
    expect(body.providers[0].version).toBe("2.1.322");
    expect(body.providers[0].installed).toBe(true);
  });

  it("never leaks env values or credential-shaped strings", async () => {
    const res = await GET();
    const text = await res.text();
    expect(text).not.toMatch(
      /sk-ant|bearer|gateway|ANTHROPIC_BASE|oauth-token|CLERK_SECRET/i,
    );
  });
});
