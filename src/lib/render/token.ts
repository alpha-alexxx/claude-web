import "server-only";
import crypto from "node:crypto";
import { isServedType, type ServedImageType } from "./mime";

/**
 * Render tokens: a short-lived, HMAC-signed grant to stream exactly one
 * resource, minted by `POST /api/render` and redeemed by `GET /api/render`.
 *
 * The token is the whole authorization decision, which is why it is signed
 * rather than stored: no server-side table to leak, expire or clean, and a
 * forged token is arithmetically impossible without the key. It carries the
 * decision the POST already made (which file, which type, for whom) so the GET
 * cannot be talked into serving something else — the payload is inside the
 * signature.
 *
 * Bound to the USER, not the Clerk session (ledgered): a session-bound token
 * would 403 every in-flight image when Clerk rotates the session id, and the
 * containment decision rests on the user, not the session.
 */

const VERSION = 1;

export interface RenderGrant {
  /** "file" streams a contained local path; "remote" re-fetches an https URL. */
  kind: "file" | "remote";
  /** Absolute contained path, or an https URL that already passed policy. */
  target: string;
  mime: ServedImageType;
  userId: string;
  /** Epoch milliseconds. The instant this value is reached the token is dead. */
  expiresAt: number;
}

interface Payload extends RenderGrant {
  v: typeof VERSION;
}

function sign(payload: string, key: Buffer): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

/** Mint a token. `expiresAt` is supplied by the caller so the TTL is one rule. */
export function mintToken(grant: RenderGrant, key: Buffer): string {
  const payload: Payload = { v: VERSION, ...grant };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/**
 * Verify a token and return its grant, or null.
 *
 * Null for every failure — bad shape, bad signature, expired, unknown version,
 * type outside the served set — because the caller answers all of them with the
 * same 404 and distinguishing them would only help an attacker.
 */
export function verifyToken(
  token: string,
  key: Buffer,
  now: number = Date.now(),
): RenderGrant | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(body, key), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length check first: timingSafeEqual throws on unequal lengths.
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const p = parsed as Record<string, unknown>;
  if (p.v !== VERSION) return null;
  if (p.kind !== "file" && p.kind !== "remote") return null;
  if (typeof p.target !== "string" || p.target.length === 0) return null;
  if (typeof p.mime !== "string" || !isServedType(p.mime)) return null;
  if (typeof p.userId !== "string" || p.userId.length === 0) return null;
  if (typeof p.expiresAt !== "number" || !Number.isFinite(p.expiresAt)) return null;
  if (p.expiresAt <= now) return null;

  return {
    kind: p.kind,
    target: p.target,
    mime: p.mime,
    userId: p.userId,
    expiresAt: p.expiresAt,
  };
}
