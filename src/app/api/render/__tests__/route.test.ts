import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireActor } from "@/lib/auth/current-actor";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { getBootDb, resetBootDbForTest } from "@/lib/db/boot";
import { resetDbForTest } from "@/lib/db/client";
import { resetRenderKeyForTest } from "@/lib/render/key";
import { useDummyEnv, clearDummyEnv } from "@/test/dummy-env";

/**
 * /api/render — the safe image proxy.
 *
 * The contract under test is split in two:
 *   POST mints a token for a target it has validated (containment for local
 *   paths, URL policy for remote ones), and the GET redeems it.
 *
 * The security properties are: a client cannot name a path outside the roots,
 * a token cannot be forged or replayed by another user or after expiry, and the
 * GET answers with an inline image typed by magic bytes, plus nosniff — never a
 * document.
 *
 * The CSP is NOT asserted here because this route does not set one: the Proxy
 * owns it (see `src/proxy.ts`), and Next drops a route header for a key the
 * Proxy already set. Asserting it here would pin a fiction.
 */

vi.mock("@/lib/auth/current-actor", () => ({ requireActor: vi.fn() }));
vi.mock("@/lib/render/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/render/remote")>();
  return { ...actual, fetchRemoteImage: vi.fn() };
});

import { GET, POST } from "../route";
import { fetchRemoteImage } from "@/lib/render/remote";
import { mintToken } from "@/lib/render/token";
import { loadRenderKey } from "@/lib/render/key";

const USER = {
  ok: true,
  user: { id: "user_1", email: "a@b.c", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const OTHER_USER = {
  ok: true,
  user: { id: "user_2", email: "b@c.d", role: "user", disabled: false },
} as unknown as Awaited<ReturnType<typeof requireActor>>;

const FORBIDDEN = {
  ok: false,
  status: 401,
  code: "unauthenticated",
} as unknown as Awaited<ReturnType<typeof requireActor>>;

// A real 1x1 PNG. The magic bytes are what the sniffer reads.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmpDir: string;
let rootDir: string;
let dataDir: string;

function req(
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
  search = "",
): Request {
  return {
    method,
    url: `http://localhost/api/render${search}`,
    headers: new Headers({ host: "localhost", origin: "http://localhost", ...headers }),
    json: async () => {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
  } as unknown as Request;
}

function getReq(search: string, headers?: Record<string, string>): Request {
  return req("GET", undefined, headers, search);
}

async function postJson(body: unknown, headers?: Record<string, string>): Promise<Response> {
  return POST(req("POST", body, headers));
}

async function mintRes(body: unknown): Promise<Response> {
  return postJson(body);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-api-"));
  rootDir = path.join(tmpDir, "root");
  dataDir = path.join(tmpDir, "data");
  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "shot.png"), PNG);
  fs.writeFileSync(path.join(rootDir, "notes.txt"), "plain text");
  fs.writeFileSync(path.join(rootDir, "page.html"), "<!doctype html><script>x</script>");
  fs.writeFileSync(path.join(tmpDir, "outside.png"), PNG);

  useDummyEnv({
    DATABASE_PATH: path.join(dataDir, "app.db"),
    ALLOWED_WORKSPACE_ROOTS: rootDir,
  });
  resetDbForTest();
  resetBootDbForTest();
  getBootDb()
    .prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'user')")
    .run("user_1", "a@b.c");
  resetRateLimits();
  resetRenderKeyForTest();
  vi.mocked(requireActor).mockResolvedValue(USER);
});

afterEach(() => {
  resetBootDbForTest();
  resetDbForTest();
  resetRenderKeyForTest();
  clearDummyEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("POST /api/render", () => {
  it("mints a token for a contained local image", async () => {
    const res = await postJson({ path: path.join(rootDir, "shot.png") });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; mime: string };
    expect(body.mime).toBe("image/png");
    expect(body.url).toBe(`/api/render?token=${encodeURIComponent(body.token)}`);
  });

  it("refuses a path outside ALLOWED_WORKSPACE_ROOTS", async () => {
    const res = await postJson({ path: path.join(tmpDir, "outside.png") });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path_not_allowed" });
  });

  it("refuses a relative path and a nonexistent one", async () => {
    for (const p of ["shot.png", path.join(rootDir, "missing.png")]) {
      const res = await postJson({ path: p });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path_not_allowed" });
    }
  });

  it("refuses an escaped symlink", async () => {
    const link = path.join(rootDir, "escape.png");
    fs.symlinkSync(path.join(tmpDir, "outside.png"), link);
    expect((await postJson({ path: link })).status).toBe(400);
  });

  it("refuses a file that is not a served image type (HTML, text)", async () => {
    for (const name of ["page.html", "notes.txt"]) {
      const res = await postJson({ path: path.join(rootDir, name) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unsupported_type" });
    }
  });

  it("refuses a remote URL that fails the https/host policy before fetching", async () => {
    for (const url of ["http://example.com/a.png", "https://127.0.0.1/a.png"]) {
      const res = await postJson({ url });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "url_not_allowed" });
    }
    expect(vi.mocked(fetchRemoteImage)).not.toHaveBeenCalled();
  });

  it("mints a remote token after the fetch proves it is an image", async () => {
    vi.mocked(fetchRemoteImage).mockResolvedValue({ bytes: new Uint8Array(PNG), mime: "image/png" });
    const res = await postJson({ url: "https://example.com/cat.png" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mime: string }).mime).toBe("image/png");
  });

  it("refuses a remote target that turns out not to be an image", async () => {
    const { FetchRemoteError } = await import("@/lib/render/remote");
    // The mock replaces the whole function, so re-imports see the mock; build
    // the real error class from the module's own export shape instead.
    vi.mocked(fetchRemoteImage).mockRejectedValue(
      new (FetchRemoteError as unknown as new (r: string) => Error)("unsupported_type"),
    );
    const res = await postJson({ url: "https://example.com/a.html" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported_type" });
  });

  it("400s on a valueless or double-target body", async () => {
    expect((await postJson({})).status).toBe(400);
    expect((await postJson({ path: "x", url: "https://e.com/a.png" })).status).toBe(400);
    expect((await postJson(undefined)).status).toBe(400);
  });

  it("requires auth and same-origin", async () => {
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await postJson({ path: path.join(rootDir, "shot.png") })).status).toBe(401);

    vi.mocked(requireActor).mockResolvedValue(USER);
    expect(
      (await postJson({ path: path.join(rootDir, "shot.png") }, { origin: "http://evil.example" }))
        .status,
    ).toBe(403);
  });

  it("rate-limits minting", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await postJson({ path: path.join(rootDir, "shot.png") })).status).toBe(200);
    }
    const res = await postJson({ path: path.join(rootDir, "shot.png") });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("GET /api/render?token=", () => {
  async function tokenFor(p: string): Promise<string> {
    const res = await mintRes({ path: p });
    return ((await res.json()) as { token: string }).token;
  }

  it("streams a contained local image with the hardening headers", async () => {
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    const res = await GET(getReq(`?token=${encodeURIComponent(token)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="image.png"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The route must not try to own the CSP: the Proxy sets it first, and a
    // second value here would be silently dropped (or, worse, make a future
    // reader believe the image response is sandboxed when it is not).
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("rejects a missing or malformed token", async () => {
    for (const search of ["", "?token=", "?token=abc", "?token=a.b.c"]) {
      expect((await GET(getReq(search))).status).toBe(404);
    }
  });

  it("rejects a forged token", async () => {
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    const tampered = `${token.split(".")[0]}.${"A".repeat(43)}`;
    expect((await GET(getReq(`?token=${encodeURIComponent(tampered)}`))).status).toBe(404);
  });

  it("rejects another user's token", async () => {
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    vi.mocked(requireActor).mockResolvedValue(OTHER_USER);
    expect((await GET(getReq(`?token=${encodeURIComponent(token)}`))).status).toBe(404);
  });

  it("rejects an expired token", async () => {
    const key = loadRenderKey(path.join(dataDir, "app.db"));
    const expired = mintToken(
      {
        kind: "file",
        target: path.join(rootDir, "shot.png"),
        mime: "image/png",
        userId: "user_1",
        expiresAt: Date.now() - 1,
      },
      key,
    );
    expect((await GET(getReq(`?token=${encodeURIComponent(expired)}`))).status).toBe(404);
  });

  it("requires a session — an image URL is not a capability URL", async () => {
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    vi.mocked(requireActor).mockResolvedValue(FORBIDDEN);
    expect((await GET(getReq(`?token=${encodeURIComponent(token)}`))).status).toBe(401);
  });

  it("re-checks containment on read, so a moved or newly-escaping file is not served", async () => {
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    // Replace the file with a symlink out of the roots after the token was
    // minted: the GET's own containment check must catch it.
    fs.rmSync(path.join(rootDir, "shot.png"));
    fs.symlinkSync(path.join(tmpDir, "outside.png"), path.join(rootDir, "shot.png"));
    expect((await GET(getReq(`?token=${encodeURIComponent(token)}`))).status).toBe(404);
  });

  it("re-fetches a remote target through the same policy", async () => {
    vi.mocked(fetchRemoteImage).mockResolvedValue({ bytes: new Uint8Array(PNG), mime: "image/png" });
    const minted = await mintRes({ url: "https://example.com/cat.png" });
    const token = ((await minted.json()) as { token: string }).token;
    const res = await GET(getReq(`?token=${encodeURIComponent(token)}`));
    expect(res.status).toBe(200);
    expect(await res.headers.get("content-type")).toBe("image/png");
    expect(vi.mocked(fetchRemoteImage)).toHaveBeenLastCalledWith(
      "https://example.com/cat.png",
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
  });

  it("404s when a remote target fails on re-fetch", async () => {
    vi.mocked(fetchRemoteImage).mockResolvedValue({ bytes: new Uint8Array(PNG), mime: "image/png" });
    const minted = await mintRes({ url: "https://example.com/cat.png" });
    const token = ((await minted.json()) as { token: string }).token;

    const { FetchRemoteError } = await import("@/lib/render/remote");
    vi.mocked(fetchRemoteImage).mockRejectedValue(
      new (FetchRemoteError as unknown as new (r: string) => Error)("timeout"),
    );
    expect((await GET(getReq(`?token=${encodeURIComponent(token)}`))).status).toBe(404);
  });

  it("rate-limits redemption, so one token cannot become an unlimited fetch loop", async () => {
    // A token is reusable for five minutes; minting is capped at 60/min but the
    // GET was not capped at all, so a single mint bought unbounded reads of a
    // remote target. The bucket counts every redemption, including the one for
    // the token minted here.
    vi.mocked(fetchRemoteImage).mockResolvedValue({ bytes: new Uint8Array(PNG), mime: "image/png" });
    const token = await tokenFor(path.join(rootDir, "shot.png"));
    const read = () => GET(getReq(`?token=${encodeURIComponent(token)}`));

    for (let i = 0; i < 180; i += 1) {
      expect((await read()).status).toBe(200);
    }
    const blocked = await read();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });
});
