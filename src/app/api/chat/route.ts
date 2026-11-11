import { z } from "zod";
import { requireActor } from "@/lib/auth/current-actor";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { sameOrigin } from "@/lib/auth/request-guards";
import { getEnv } from "@/lib/env";
import { getAdapter } from "@/lib/providers/registry";
import { createTurnSsePipe } from "@/lib/providers/claude/sse-pipe";
import { createSessionBinding } from "@/lib/providers/claude/binding";
import { getPermissionBroker } from "@/lib/providers/claude/broker";
import type { ProviderId } from "@/lib/providers/types";
import { getBootDb } from "@/lib/db/boot";
import {
  conversationIdFor,
  ensureConversation,
} from "@/lib/db/conversations-repo";
import { resolveWorkspacePath } from "@/lib/workspace";

/**
 * POST /api/chat — one user turn as an SSE stream.
 *
 * Order matters and mirrors the plan's threat model:
 *   1. auth (inside the handler — Proxy coverage is not trusted)
 *   2. Origin check (CSRF; the app is same-origin only)
 *   3. rate limit (per-user turn budget, 429 + Retry-After)
 *   4. body validation (zod, 1 MB cap enforced by the size check below)
 *   5. cwd containment (realpath inside ALLOWED_WORKSPACE_ROOTS)
 *   6. provider availability (enabled AND implemented)
 *   7. conversation row (server-derived id — the audit FK needs it first)
 *   8. session start with its permission/audit binding → SSE pipe
 *
 * Disconnect: cancelling the response stream detaches the listener only; the
 * turn keeps running in the pool (legacy parity) and Stop is a separate
 * endpoint that calls interrupt().
 *
 * No segment config: `cacheComponents` rejects `dynamic = "force-dynamic"` at
 * build time. A POST handler is never prerendered; auth + the SSE stream keep
 * the response request-time.
 */

const BodySchema = z.object({
  /** Client-side conversation id; scoped per user before it reaches a pool. */
  conversationId: z.string().min(1).max(128),
  provider: z.enum(["claude", "codex", "opencode", "qoder"]),
  cwd: z.string().min(1).max(4096),
  text: z.string().min(1).max(200_000),
  model: z.string().min(1).max(128).optional(),
  /** Resume target for a reopened conversation (CLI session id). */
  resumeSessionId: z.string().min(1).max(128).optional(),
});

const MAX_BODY_BYTES = 1_000_000;

function json(status: number, error: string, headers?: Record<string, string>) {
  return Response.json({ error }, { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  const decision = await requireActor("user");
  if (!decision.ok) {
    return json(decision.status, decision.code);
  }
  const user = decision.user;

  if (!sameOrigin(req)) return json(403, "cross_origin");

  const limit = checkRateLimit(
    { bucket: "turn", id: String(user.id) },
    RATE_LIMITS.turn,
  );
  if (!limit.allowed) {
    return json(429, "rate_limited", {
      "retry-after": String(limit.retryAfterSec),
    });
  }

  // Body cap before parsing — an oversized body should cost one header check.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, "body_too_large");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, "invalid_json");
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return json(400, "invalid_body");
  const body = parsed.data;

  const cwd = resolveWorkspacePath(getEnv().ALLOWED_WORKSPACE_ROOTS, body.cwd);
  if (!cwd) return json(400, "cwd outside allowed workspace roots");

  const adapter = getAdapter(body.provider as ProviderId);
  if (!adapter) {
    return json(400, `provider "${body.provider}" is not available`);
  }

  // Server-derived, user-scoped key: it is the pool key AND the conversations
  // PK. The row must exist before the first audit write (tool_calls → FK).
  const sessionKey = conversationIdFor(String(user.id), body.conversationId);
  try {
    ensureConversation(getBootDb(), {
      id: sessionKey,
      userId: String(user.id),
      provider: body.provider,
      cwd,
      model: body.model ?? null,
    });
  } catch (err) {
    return json(503, err instanceof Error ? err.message : "database unavailable");
  }

  // Session-lifetime hooks. The pool binds them at CREATION and never re-reads
  // them, so they may only depend on the session key — never on this turn's
  // text. A reused session keeps the binding built when it was created.
  const binding = createSessionBinding({
    userId: String(user.id),
    sessionKey,
    conversationId: sessionKey,
    db: getBootDb(),
    broker: getPermissionBroker(),
  });

  let session;
  try {
    session = await adapter.startsSession({
      conversationId: sessionKey,
      cwd,
      model: body.model ?? null,
      resumeSessionId: body.resumeSessionId ?? null,
      onPermission: binding.onPermission,
      isToolAllowed: binding.isToolAllowed,
      onSessionClosed: binding.onSessionClosed,
    });
  } catch (err) {
    // Pool at capacity / CLI failed to spawn — a real, retryable condition.
    return json(503, err instanceof Error ? err.message : "session unavailable");
  }

  // Result audit is session-lifetime, not turn-lifetime: a tool can finish
  // after this turn's stream closed. attach() is idempotent per session.
  binding.attach(session);

  const pipe = createTurnSsePipe(session, {
    timeoutMs: getEnv().TURN_TIMEOUT_MS,
    heartbeatMs: 20_000,
  });
  // Kick the turn after the stream exists so its listener is attached first.
  void pipe.send(body.text);

  return new Response(pipe.stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // Disable proxy buffering (nginx) — SSE must flow immediately.
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
