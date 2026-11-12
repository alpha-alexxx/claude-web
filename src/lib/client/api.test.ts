import { describe, expect, it, vi } from "vitest";
import { getJson, sendJson, asRecord, failureFrom } from "./api";

/**
 * api.ts: the one place every admin surface's HTTP goes through.
 *
 * The contract pinned here is what makes the pages safe to render: a call
 * never rejects, a non-JSON body is not mistaken for success, and a server
 * refusal keeps BOTH its `error` form (auth gates) and `code` form (409
 * refusals). That last pair matters — reading only one would turn half the
 * refusals into an unhelpful `http_500`.
 */

function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("getJson", () => {
  it("returns the parsed body with no-store", async () => {
    const f = vi.fn(async () => respond({ hello: "world" }));
    expect(await getJson("/api/x", f)).toEqual({ ok: true, body: { hello: "world" } });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.cache).toBe("no-store");
  });

  it("resolves to `network` instead of rejecting", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await getJson("/api/x", f)).toEqual({ ok: false, code: "network" });
  });

  it("keeps the server's `error` code and message", async () => {
    const f = vi.fn(async () => respond({ error: "forbidden" }, 403));
    expect(await getJson("/api/x", f)).toEqual({
      ok: false,
      code: "forbidden",
      message: undefined,
    });
  });

  it("keeps the server's `code` form used by refusals", async () => {
    const f = vi.fn(async () =>
      respond({ ok: false, code: "refused", message: "stored file does not parse" }, 409),
    );
    expect(await getJson("/api/x", f)).toEqual({
      ok: false,
      code: "refused",
      message: "stored file does not parse",
    });
  });

  it("falls back to a status code when the body has neither", async () => {
    const f = vi.fn(async () => respond({ nope: true }, 502));
    expect(await getJson("/api/x", f)).toMatchObject({ ok: false, code: "http_502" });
  });

  it("treats an OK response with no JSON body as invalid, not success", async () => {
    const f = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    expect(await getJson("/api/x", f)).toEqual({ ok: false, code: "invalid_response" });
  });
});

describe("sendJson", () => {
  it("posts JSON with the right method and headers", async () => {
    const f = vi.fn(async () => respond({ ok: true }));
    await sendJson("/api/y", "PUT", { a: 1 }, f);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/y");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ a: 1 });
  });

  it("resolves to a failure on a refused write", async () => {
    const f = vi.fn(async () => respond({ error: "rate_limited" }, 429));
    expect(await sendJson("/api/y", "POST", {}, f)).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
  });
});

describe("asRecord / failureFrom", () => {
  it("rejects arrays and null as records", () => {
    expect(asRecord([])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("prefers `error` over `code` when both are present", () => {
    expect(failureFrom({ error: "forbidden", code: "other" }, 403)).toMatchObject({
      code: "forbidden",
    });
  });
});
