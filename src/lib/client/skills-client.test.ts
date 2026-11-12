import { describe, expect, it, vi } from "vitest";
import { getSkills, setSkillSync } from "./skills-client";

/**
 * skills-client: the browser half of /api/skills.
 *
 * Two things pinned: the slug is URL-encoded (it becomes a directory name on
 * the server, but here it is a path segment and must not reshape the URL), and
 * a refusal's reason survives — that reason is the whole point of the badge
 * tooltip, since the server is the only place that knows a real directory is
 * in the way.
 */

const VIEW = {
  storePath: "/home/u/.agents/skills",
  tools: [{ tool: "claude", mode: "symlink", state: "ready", path: "/home/u/.claude/skills" }],
  skills: [
    {
      slug: "alpha",
      name: "Alpha",
      description: null,
      malformed: false,
      tools: { claude: "synced", codex: "synced", opencode: "synced", qoder: "missing" },
    },
  ],
};

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getSkills", () => {
  it("returns the view", async () => {
    const f = vi.fn(async () => respond(VIEW));
    expect(await getSkills({ fetch: f })).toEqual({ ok: true, view: VIEW });
    expect(f).toHaveBeenCalledWith("/api/skills", expect.objectContaining({ method: "GET" }));
  });

  it("rejects a body that is not a skills view", async () => {
    const f = vi.fn(async () => respond({ skills: "nope" }));
    expect(await getSkills({ fetch: f })).toEqual({ ok: false, code: "invalid_response" });
  });

  it("passes an auth failure through", async () => {
    const f = vi.fn(async () => respond({ error: "forbidden" }, 403));
    expect(await getSkills({ fetch: f })).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("setSkillSync", () => {
  it("encodes the slug and sends tool + action only", async () => {
    const f = vi.fn(async () => respond({ ok: true }));
    expect((await setSkillSync("a/b", "qoder", "sync", { fetch: f })).ok).toBe(true);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/skills/a%2Fb/sync");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ tool: "qoder", action: "sync" });
  });

  it("surfaces the refusal reason so the badge can explain itself", async () => {
    const f = vi.fn(async () =>
      respond(
        { ok: false, code: "refused", message: "/home/u/.qoder/skills/alpha already exists" },
        409,
      ),
    );
    expect(await setSkillSync("alpha", "qoder", "sync", { fetch: f })).toEqual({
      ok: false,
      code: "refused",
      message: "/home/u/.qoder/skills/alpha already exists",
    });
  });

  it("resolves to a network failure rather than throwing", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await setSkillSync("alpha", "qoder", "unsync", { fetch: f })).toEqual({
      ok: false,
      code: "network",
    });
  });
});
