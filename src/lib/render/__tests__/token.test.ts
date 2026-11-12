import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mintToken, verifyToken, type RenderGrant } from "../token";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const NOW = 1_700_000_000_000;

const grant: RenderGrant = {
  kind: "file",
  target: "/home/ubuntu/projects/a/shot.png",
  mime: "image/png",
  userId: "user_1",
  expiresAt: NOW + 300_000,
};

describe("mintToken / verifyToken", () => {
  it("round-trips a grant", () => {
    const token = mintToken(grant, KEY);
    expect(verifyToken(token, KEY, NOW)).toEqual(grant);
  });

  it("is URL-safe", () => {
    const token = mintToken(grant, KEY);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token).toBe(encodeURIComponent(token));
  });

  it("rejects a token signed with another key", () => {
    expect(verifyToken(mintToken(grant, KEY), OTHER_KEY, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const [payload, sig] = mintToken(grant, KEY).split(".");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.target = "/etc/shadow";
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${sig}`;
    expect(verifyToken(forged, KEY, NOW)).toBeNull();
  });

  it("rejects an expired token, and the instant after expiry", () => {
    const token = mintToken(grant, KEY);
    expect(verifyToken(token, KEY, grant.expiresAt - 1)).not.toBeNull();
    expect(verifyToken(token, KEY, grant.expiresAt)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", ".", "abc", "abc.def", "a.b.c", "!!!.???"]) {
      expect(verifyToken(bad, KEY, NOW)).toBeNull();
    }
  });

  it("rejects a correctly signed but structurally wrong payload", () => {
    const evil = Buffer.from(
      JSON.stringify({ v: 1, kind: "file", target: "/etc/passwd", mime: "image/png" }),
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", KEY).update(evil).digest("base64url");
    expect(verifyToken(`${evil}.${sig}`, KEY, NOW)).toBeNull();
  });

  it("rejects a payload whose kind or mime is outside the contract", () => {
    const base = { ...grant, v: 1 };
    const sign = (obj: unknown) => {
      const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
      return `${p}.${crypto.createHmac("sha256", KEY).update(p).digest("base64url")}`;
    };
    expect(verifyToken(sign({ ...base, kind: "http" }), KEY, NOW)).toBeNull();
    expect(verifyToken(sign({ ...base, mime: "text/html" }), KEY, NOW)).toBeNull();
  });
});
