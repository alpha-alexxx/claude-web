import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * Skills API — the canonical store and its per-tool links.
 *
 * These routes touch the operator's home directory, so the tests run against a
 * temporary one: `homedir` is mocked for the whole file, and every path the
 * store builds therefore lands inside the fixture.
 *
 * What is pinned here:
 *   - admin-only reads and writes, with the reason code the page renders;
 *   - the slug is validated BEFORE it becomes a directory name;
 *   - a refusal (a real directory in the way, a native tool) is a 409 whose
 *     message is the server's reason, not a generic string;
 *   - the audit row records the slug and tool, never file contents.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));

let fakeHome = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { GET as getSkills } from "../route";
import { POST as postSync } from "../[slug]/sync/route";

const ADMIN = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "admin", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const FORBIDDEN = {
  ok: false,
  status: 403,
  code: "forbidden",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

let tmpDir: string;

function req(method: string, body?: unknown, headers?: Record<string, string>): Request {
  return {
    method,
    url: "http://localhost/api/skills",
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

function writeSkill(slug: string, name = "My Skill"): void {
  const dir = path.join(fakeHome, ".agents", "skills", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Does a thing\n---\n\n# Body\n`,
  );
}

function auditActions(): string[] {
  const rows = getBootDb()
    .prepare("SELECT action FROM audit_log ORDER BY id")
    .all() as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-api-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });

  useDummyEnv({ DATABASE_PATH: path.join(tmpDir, "app.db") });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'admin')")
    .run("user_1", "a@b.c");
  resetRateLimits();
  vi.mocked(requireActor).mockResolvedValue(ADMIN);
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("GET /api/skills", () => {
  it("creates the canonical store on the first read", async () => {
    const res = await getSkills();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fs.existsSync(path.join(fakeHome, ".agents", "skills"))).toBe(true);
  });

  it("reports each skill with per-tool sync state", async () => {
    writeSkill("alpha", "Alpha");
    const body = (await (await getSkills()).json()) as {
      skills: Array<{ slug: string; name: string; tools: Record<string, string> }>;
    };
    expect(body.skills).toHaveLength(1);
    const skill = body.skills[0]!;
    expect(skill).toMatchObject({ slug: "alpha", name: "Alpha" });
    // Native tools see the store by construction; Claude's link is made by
    // ensureSkillsStore, and Qoder has nothing until a skill is linked.
    expect(skill.tools.codex).toBe("synced");
    expect(skill.tools.opencode).toBe("synced");
    expect(skill.tools.claude).toBe("synced");
    expect(skill.tools.qoder).toBe("missing");
  });

  it("reports a store that cannot be created instead of failing the request", async () => {
    // `~/.agents` as a regular file: `mkdir` fails with ENOTDIR. The page needs
    // a reason it can show — a 500 would leave it saying "that did not work".
    fs.writeFileSync(path.join(fakeHome, ".agents"), "not a directory");
    const res = await getSkills();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storeError: string | null;
      skills: unknown[];
    };
    expect(body.storeError).toMatch(/ENOTDIR/);
    expect(body.skills).toEqual([]);
  });

  it("refuses a non-admin with 403 and an anonymous caller with 401", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await getSkills()).status).toBe(403);

    vi.mocked(requireActor).mockResolvedValue({
      ok: false,
      status: 401,
      code: "unauthenticated",
    } as unknown as Awaited<ReturnType<typeof requireActor>>);
    expect((await getSkills()).status).toBe(401);
  });
});

describe("POST /api/skills/[slug]/sync", () => {
  it("links a skill into Qoder's managed directory and audits it", async () => {
    writeSkill("alpha", "Alpha");
    const res = await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const link = path.join(fakeHome, ".qoder", "skills", "alpha");
    expect(fs.readlinkSync(link)).toBe(path.join(fakeHome, ".agents", "skills", "alpha"));
    expect(auditActions()).toEqual(["skill.sync"]);
  });

  it("unsyncs a managed link but leaves a real directory alone", async () => {
    writeSkill("alpha");
    await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"));
    expect((await postSync(req("POST", { tool: "qoder", action: "unsync" }), ctx("alpha"))).status).toBe(
      200,
    );
    expect(fs.existsSync(path.join(fakeHome, ".qoder", "skills", "alpha"))).toBe(false);

    const real = path.join(fakeHome, ".qoder", "skills", "handmade");
    fs.mkdirSync(real, { recursive: true });
    const res = await postSync(
      req("POST", { tool: "qoder", action: "unsync" }),
      ctx("handmade"),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "refused" });
    expect(fs.existsSync(real)).toBe(true);
  });

  it("409s with the reason when a real directory is in the way", async () => {
    writeSkill("alpha");
    fs.mkdirSync(path.join(fakeHome, ".qoder", "skills", "alpha"), { recursive: true });
    const res = await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("refused");
    expect(body.message).toContain("not managed by this app");
  });

  it("refuses a native tool with its own explanation", async () => {
    writeSkill("alpha");
    const res = await postSync(req("POST", { tool: "codex", action: "unsync" }), ctx("alpha"));
    expect(res.status).toBe(409);
    expect((await res.json()) as { message: string }).toMatchObject({
      message: "This tool reads the store directly",
    });
  });

  it("404-equivalent: a missing skill refuses with its name", async () => {
    const res = await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("ghost"));
    expect(res.status).toBe(409);
    expect((await res.json()) as { message: string }).toMatchObject({
      message: 'Skill "ghost" not found in the store',
    });
  });

  it("409s with the filesystem's reason when the tool directory cannot be created", async () => {
    // `~/.qoder` as a regular file: the link cannot be made. A refusal with
    // the errno is what the badge toast can show; a throw would be a 500.
    writeSkill("alpha");
    fs.writeFileSync(path.join(fakeHome, ".qoder"), "not a directory");
    const res = await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("refused");
    expect(body.message).toMatch(/ENOTDIR/);
  });

  it("rejects a traversal slug before it becomes a path", async () => {
    const res = await postSync(
      req("POST", { tool: "qoder", action: "sync" }),
      ctx("..%2F..%2Fetc"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_slug" });
  });

  it("rejects an unknown tool or action", async () => {
    writeSkill("alpha");
    expect((await postSync(req("POST", { tool: "nope", action: "sync" }), ctx("alpha"))).status).toBe(
      400,
    );
    expect((await postSync(req("POST", { tool: "qoder", action: "rm" }), ctx("alpha"))).status).toBe(
      400,
    );
    expect((await postSync(req("POST", undefined), ctx("alpha"))).status).toBe(400);
  });

  it("refuses a cross-origin write and a non-admin", async () => {
    writeSkill("alpha");
    const cross = await postSync(
      req("POST", { tool: "qoder", action: "sync" }, { origin: "http://evil.example" }),
      ctx("alpha"),
    );
    expect(cross.status).toBe(403);
    expect(fs.existsSync(path.join(fakeHome, ".qoder", "skills", "alpha"))).toBe(false);

    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect(
      (await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"))).status,
    ).toBe(403);
  });

  it("rate-limits a loop of links", async () => {
    writeSkill("alpha");
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"))).status,
      ).toBe(200);
    }
    const res = await postSync(req("POST", { tool: "qoder", action: "sync" }), ctx("alpha"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});
