import { z } from "zod";
import fs from "node:fs";
import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { BODY_CAPS, bodyTooLarge, sameOrigin } from "@/lib/auth/request-guards";
import { getEnv } from "@/lib/env";
import { resolveWorkspacePath } from "@/lib/workspace";
import { FILE_NAME, sniffImageType } from "@/lib/render/mime";
import { loadRenderKey } from "@/lib/render/key";
import { mintToken, verifyToken } from "@/lib/render/token";
import { checkRemoteUrl, fetchRemoteImage, FetchRemoteError } from "@/lib/render/remote";

/**
 * /api/render — the safe image proxy.
 *
 * Agent output is untrusted, so an image is never referenced by a raw path or a
 * raw URL in the DOM. The client POSTs a target, the server validates it
 * (containment inside ALLOWED_WORKSPACE_ROOTS for a local path; https-only plus
 * an SSRF policy for a remote one) and answers with a 5-minute HMAC token. The
 * GET redeems the token and streams the bytes — inline and nosniff, typed by
 * magic bytes from a served set that excludes SVG/HTML — so the response can
 * only ever be an image, never a document that runs script in this origin.
 *
 * Why a token rather than a query parameter?: the containment decision is the
 * expensive and security-relevant half. Minting it ties the decision to a
 * signed grant that names the user it was made for; the GET then only has to
 * confirm the grant still belongs to the caller. Every grant is re-validated on
 * redemption anyway (the file could have been replaced by a symlink in the five
 * minutes since), so a token is a cache of the decision, never a bypass of it.
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"`;
 * both handlers read auth cookies, so they are request-time already.
 */

/** Same cap the remote policy enforces: a 10 MB image is already generous. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60 * 1000;

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * The image response's own headers.
 *
 * There is deliberately NO `content-security-policy` here. The Proxy is the one
 * owner of that header: it runs first, and Next applies routing/Proxy headers
 * with `res.setHeader` before the route response is sent, after which a header
 * already present wins — so a CSP set here would be dropped on every request
 * the Proxy matches, i.e. always. A header that never reaches the wire is worse
 * than no header: it reads as a protection in review and asserts itself in
 * tests while protecting nothing. The containment that actually holds for this
 * response is structural: a magic-byte type from a set that excludes SVG and
 * HTML, `nosniff`, and `content-disposition: inline` under that type.
 */
const IMAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-disposition": "inline",
  // The token is short-lived and the underlying file can change between
  // requests, so a cached render would be a stale render.
  "cache-control": "private, no-store",
} as const;

const BodySchema = z.union([
  z.object({ path: z.string().min(1).max(4096) }).strict(),
  z.object({ url: z.string().min(1).max(4096) }).strict(),
]);

function json(status: number, error: string, headers?: Record<string, string>) {
  return Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * Map a remote failure onto the minting response. A policy refusal is the
 * client's fault (400); a target that would not answer is not (502), and the
 * distinction is what lets the UI say "that URL is not allowed" instead of
 * "try again".
 */
function remoteErrorToResponse(err: FetchRemoteError): Response {
  switch (err.reason) {
    case "invalid_url":
    case "insecure_scheme":
    case "destination_not_allowed":
      return json(400, "url_not_allowed");
    case "unsupported_type":
      return json(400, "unsupported_type");
    case "too_large":
      return json(400, "too_large");
    case "bad_status":
    case "timeout":
    case "fetch_failed":
      return json(502, "fetch_failed");
  }
}

function readFileCapped(file: string): Buffer | null {
  const stat = fs.statSync(file); // resolveWorkspacePath already stat'd it
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  return fs.readFileSync(file);
}

/** POST { path } | { url } → { token, url, mime } */
export async function POST(req: Request): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) return json(decision.status, decision.code);
  const user = decision.user;

  if (!sameOrigin(req)) return json(403, "cross_origin");

  const limit = checkRateLimit({ bucket: "render", id: String(user.id) }, RATE_LIMITS.render);
  if (!limit.allowed) {
    return json(429, "rate_limited", { "retry-after": String(limit.retryAfterSec) });
  }

  if (bodyTooLarge(req, BODY_CAPS.render)) return json(413, "body_too_large");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, "invalid_json");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json(400, "invalid_body");
  const body = parsed.data;

  let target: string;
  let kind: "file" | "remote";
  let mime: ReturnType<typeof sniffImageType>;

  if ("path" in body) {
    const file = resolveWorkspacePath(getEnv().ALLOWED_WORKSPACE_ROOTS, body.path);
    if (!file) return json(400, "path_not_allowed");

    let bytes: Buffer | null;
    try {
      bytes = readFileCapped(file);
    } catch {
      return json(400, "path_not_allowed");
    }
    if (!bytes) return json(400, "too_large");

    mime = sniffImageType(bytes);
    if (!mime) return json(400, "unsupported_type");
    target = file;
    kind = "file";
  } else {
    try {
      checkRemoteUrl(body.url);
      const image = await fetchRemoteImage(body.url, {
        fetchImpl: fetch,
        maxBytes: MAX_FILE_BYTES,
      });
      mime = image.mime;
    } catch (err) {
      if (err instanceof FetchRemoteError) return remoteErrorToResponse(err);
      return json(502, "fetch_failed");
    }
    // Store the URL exactly as the policy consumed it, so the GET re-runs the
    // same check on the same string rather than on a re-parse of something else.
    target = body.url;
    kind = "remote";
  }

  if (!mime) return json(400, "unsupported_type");

  const token = mintToken(
    {
      kind,
      target,
      mime,
      userId: String(user.id),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    },
    loadRenderKey(getEnv().DATABASE_PATH),
  );

  return Response.json(
    { token, url: `/api/render?token=${encodeURIComponent(token)}`, mime },
    { headers: NO_STORE },
  );
}

/**
 * GET ?token=… → the bytes.
 *
 * Auth IS required. A token is not a capability URL: it is scoped to the user
 * it was minted for and checked against the current session, so a copied link
 * is useless outside that session.
 *
 * Both branches re-validate on read — containment is re-resolved for a file
 * (the token could outlive a rename or a symlink swap) and the URL policy is
 * re-applied for a remote target. Failures are 404 across the board: a
 * distinguishable 403 would tell a probe which half of the check it cleared.
 *
 * Redemption has its own bucket, higher than minting but finite: a token is
 * reusable for its five-minute life, so without this a single mint would buy
 * unlimited reads (and, for a remote target, unlimited outbound fetches).
 */
export async function GET(req: Request): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) return json(decision.status, decision.code);
  const user = decision.user;

  // A token can be redeemed repeatedly for its five-minute life, and a remote
  // one re-fetches on every read — so the mint cap alone would leave the GET
  // as an unmetered outbound-fetch primitive once a token exists.
  const limit = checkRateLimit(
    { bucket: "render-read", id: String(user.id) },
    RATE_LIMITS.renderRead,
  );
  if (!limit.allowed) {
    return json(429, "rate_limited", { "retry-after": String(limit.retryAfterSec) });
  }

  const token = new URL(req.url).searchParams.get("token") ?? "";
  const grant = verifyToken(token, loadRenderKey(getEnv().DATABASE_PATH));
  if (!grant || grant.userId !== String(user.id)) return json(404, "not_found");

  let bytes: Uint8Array;
  let mime: string;

  if (grant.kind === "file") {
    const file = resolveWorkspacePath(getEnv().ALLOWED_WORKSPACE_ROOTS, grant.target);
    if (!file) return json(404, "not_found");

    let read: Buffer | null;
    try {
      read = readFileCapped(file);
    } catch {
      return json(404, "not_found");
    }
    if (!read) return json(404, "not_found");

    // The bytes are re-sniffed, not trusted from the grant: if the file was
    // replaced with something else, the replacement's real type is what gets
    // served — and SVG/HTML are never in the served set.
    const actual = sniffImageType(read);
    if (!actual) return json(404, "not_found");
    bytes = read;
    mime = actual;
  } else {
    try {
      const image = await fetchRemoteImage(grant.target, {
        fetchImpl: fetch,
        maxBytes: MAX_FILE_BYTES,
      });
      bytes = image.bytes;
      mime = image.mime;
    } catch {
      return json(404, "not_found");
    }
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...IMAGE_HEADERS,
      "content-type": mime,
      "content-disposition": `inline; filename="${FILE_NAME(mime)}"`,
      "content-length": String(bytes.byteLength),
    },
  });
}
