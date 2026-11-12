import { describe, it, expect } from "vitest";
import { BODY_CAPS, bodyTooLarge, sameOrigin } from "../request-guards";

/**
 * The body cap is a DECLARED-length check, not a stream counter: its job is to
 * reject an oversized body before `req.json()` buffers it. These cases pin the
 * edges the routes depend on — a cap that under-fires is a documented control
 * the code does not enforce; one that over-fires rejects legitimate payloads.
 */

function req(headers: Record<string, string> = {}): Request {
  return { headers: new Headers(headers) } as unknown as Request;
}

describe("bodyTooLarge", () => {
  it("accepts a body at the cap and refuses one byte over", () => {
    expect(bodyTooLarge(req({ "content-length": "65536" }), 65536)).toBe(false);
    expect(bodyTooLarge(req({ "content-length": "65537" }), 65536)).toBe(true);
  });

  it("defaults to the small-mutation cap", () => {
    expect(bodyTooLarge(req({ "content-length": String(BODY_CAPS.mutation + 1) }))).toBe(true);
  });

  it("allows a missing content-length through to the zod bounds", () => {
    // Chunked uploads declare nothing. Rejecting them here would break the
    // streaming client; each route's schema still bounds the parsed shape.
    expect(bodyTooLarge(req())).toBe(false);
  });

  it("does not reject on an unparseable content-length", () => {
    expect(bodyTooLarge(req({ "content-length": "nonsense" }))).toBe(false);
  });

  it("caps a general body at 1 MB", () => {
    expect(bodyTooLarge(req({ "content-length": "1000000" }), BODY_CAPS.general)).toBe(false);
    expect(bodyTooLarge(req({ "content-length": "1000001" }), BODY_CAPS.general)).toBe(true);
  });
});

describe("sameOrigin", () => {
  it("accepts a matching origin and refuses a foreign one", () => {
    expect(sameOrigin(req({ origin: "http://x", host: "x" }))).toBe(true);
    expect(sameOrigin(req({ origin: "http://evil", host: "x" }))).toBe(false);
  });

  it("treats a missing Origin as a non-browser client, not a CSRF vector", () => {
    expect(sameOrigin(req({ host: "x" }))).toBe(true);
  });
});
