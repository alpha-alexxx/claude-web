import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PermissionBroker,
  type PendingPermissionRequest,
} from "../claude/permissions";

/**
 * The permission broker is the answer path for interactive Allow/Deny cards.
 *
 * Contract:
 * - request() suspends until resolve() answers it, times out, or the session
 *   goes away — it NEVER rejects and never leaves a CLI call hanging.
 * - resolve() is user-scoped: another user's requestId is not found, not
 *   "resolved anyway". The card is a privileged control on a live agent.
 * - "allow_session" adds the tool to that conversation's allowlist so the
 *   next call is answered immediately (never a second card).
 * - fail-closed: timeout / eviction / unknown state all deny.
 */

const OPTS = { timeoutMs: 60_000 };

function request(over: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest {
  return {
    userId: "user_1",
    sessionKey: "user_1:conv-1",
    conversationId: "conv-1",
    requestId: "req-1",
    toolUseId: "tu_1",
    toolName: "Bash",
    input: { command: "ls" },
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PermissionBroker", () => {
  it("resolve('allow') answers the waiting canUseTool promise", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    expect(broker.pendingCount()).toBe(1);

    const result = broker.resolve("user_1", "req-1", "allow");
    expect(result).toEqual({ ok: true, decision: "allow" });
    await expect(pending).resolves.toEqual({ behavior: "allow" });
    expect(broker.pendingCount()).toBe(0);
  });

  it("resolve('deny') carries the deny answer", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    broker.resolve("user_1", "req-1", "deny");
    const answer = await pending;
    expect(answer.behavior).toBe("deny");
  });

  it("allow_session answers now AND pre-approves that tool for the session only", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    broker.resolve("user_1", "req-1", "allow_session");
    await expect(pending).resolves.toEqual({ behavior: "allow" });

    expect(broker.isToolAllowed("user_1:conv-1", "Bash")).toBe(true);
    // Another conversation of the same user — and another user — are separate.
    expect(broker.isToolAllowed("user_1:conv-2", "Bash")).toBe(false);
    expect(broker.isToolAllowed("user_2:conv-1", "Bash")).toBe(false);
    // The allowlist is per TOOL, not a blanket allow.
    expect(broker.isToolAllowed("user_1:conv-1", "Write")).toBe(false);
  });

  it("is user-scoped: another user's requestId is not found", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    const result = broker.resolve("user_2", "req-1", "allow");
    expect(result).toEqual({ ok: false, code: "not_found" });
    expect(broker.pendingCount()).toBe(1);

    broker.resolve("user_1", "req-1", "deny");
    await expectedDeny(pending);
  });

  it("a second resolve of the same request is not_found (single-use)", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    expect(broker.resolve("user_1", "req-1", "allow")).toEqual({
      ok: true,
      decision: "allow",
    });
    expect(broker.resolve("user_1", "req-1", "deny")).toEqual({
      ok: false,
      code: "not_found",
    });
    await expectedAllow(pending);
  });

  it("unknown requestId is not_found", () => {
    const broker = new PermissionBroker(OPTS);
    expect(broker.resolve("user_1", "nope", "allow")).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("times out to DENY (fail closed) and drops the pending entry", async () => {
    vi.useFakeTimers();
    const broker = new PermissionBroker({ timeoutMs: 5_000 });
    const pending = broker.request(request());
    vi.advanceTimersByTime(5_000);

    const answer = await pending;
    expect(answer.behavior).toBe("deny");
    expect(answer.behavior === "deny" && answer.message).toMatch(/timed out/i);
    expect(broker.pendingCount()).toBe(0);
  });

  it("forgetSession denies its pending requests and clears the allowlist", async () => {
    const broker = new PermissionBroker(OPTS);
    const pending = broker.request(request());
    broker.request(request({ requestId: "req-2" }));
    broker.resolve("user_1", "req-2", "allow_session");

    broker.forgetSession("user_1:conv-1");

    const answer = await pending;
    expect(answer.behavior).toBe("deny");
    expect(broker.pendingCount()).toBe(0);
    expect(broker.isToolAllowed("user_1:conv-1", "Bash")).toBe(false);
  });

  it("forgetSession leaves other sessions untouched", async () => {
    const broker = new PermissionBroker(OPTS);
    const other = broker.request(
      request({ userId: "user_2", sessionKey: "user_2:conv-9" }),
    );
    broker.forgetSession("user_1:conv-1");
    expect(broker.pendingCount()).toBe(1);
    broker.resolve("user_2", "req-1", "allow");
    await expectedAllow(other);
  });
});

async function expectedAllow(p: Promise<{ behavior: "allow" | "deny" }>) {
  await expect(p).resolves.toEqual({ behavior: "allow" });
}

async function expectedDeny(p: Promise<{ behavior: "allow" | "deny" }>) {
  await expect(p).resolves.toMatchObject({ behavior: "deny" });
}
