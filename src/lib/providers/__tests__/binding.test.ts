import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrate } from "../../db/migrate";
import { conversationIdFor, ensureConversation } from "../../db/conversations-repo";
import { listToolCalls } from "../../db/tool-calls-repo";
import { PermissionBroker } from "../claude/permissions";
import type { TurnEvent } from "../types";
import {
  createSessionBinding,
  resetSessionBindingForTest,
  attachedSessionCountForTest,
} from "../claude/binding";

/**
 * The binding is the one place that turns a (user, conversation) pair into
 * the three session-lifetime hooks the pool demands. Every hook is a pure
 * function of the session key — the pool binds them at session CREATION and
 * never re-reads them — so the tests here always build them from the same
 * inputs a second turn would use.
 *
 * Two jobs are proven here:
 *   - the permission card round trip (broker ownership + fail-closed answers)
 *   - the audit trail: pending row BEFORE the answer, decision after it, and
 *     the tool result attached later without ever conjuring duplicate rows
 */

const USER = "user_1";
const CLIENT_ID = "c1";
const KEY = conversationIdFor(USER, CLIENT_ID);

let dir: string;
let db: DatabaseSync;
let broker: PermissionBroker;

function binding(overrides: Partial<{ sessionKey: string }> = {}) {
  return createSessionBinding({
    userId: USER,
    sessionKey: overrides.sessionKey ?? KEY,
    conversationId: overrides.sessionKey ?? KEY,
    db,
    broker,
  });
}

const REQ = {
  requestId: "req-1",
  toolUseId: "tu-1",
  toolName: "Bash",
  input: { command: "ls" },
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "binding-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare(
    "INSERT INTO users (id, email, role) VALUES (?, ?, 'user')",
  ).run(USER, "a@b.c");
  ensureConversation(db, {
    id: KEY,
    userId: USER,
    provider: "claude",
    cwd: "/w",
    model: null,
  });
  broker = new PermissionBroker({ timeoutMs: 60_000 });
  resetSessionBindingForTest();
});

afterEach(() => {
  resetSessionBindingForTest();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("permission round trip", () => {
  it("suspends until the broker resolves, then returns the user's answer", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    expect(broker.pendingCount()).toBe(1);
    expect(broker.resolve(USER, "req-1", "allow")).toEqual({
      ok: true,
      decision: "allow",
    });
    await expect(answer).resolves.toEqual({ behavior: "allow" });
  });

  it("returns deny for a denial", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    broker.resolve(USER, "req-1", "deny");
    await expect(answer).resolves.toEqual({ behavior: "deny" });
  });

  it("another user cannot answer this session's request (user-scoped)", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    expect(broker.resolve("user_2", "req-1", "allow")).toEqual({
      ok: false,
      code: "not_found",
    });
    // Still pending — the wrong user's click changed nothing.
    expect(broker.pendingCount()).toBe(1);
    broker.resolve(USER, "req-1", "deny");
    await expect(answer).resolves.toEqual({ behavior: "deny" });
  });

  it("isToolAllowed reflects allow-for-session for THIS conversation only", async () => {
    const b = binding();
    expect(b.isToolAllowed("Bash")).toBe(false);
    const answer = b.onPermission({ ...REQ });
    broker.resolve(USER, "req-1", "allow_session");
    await answer;
    expect(b.isToolAllowed("Bash")).toBe(true);
    expect(b.isToolAllowed("Write")).toBe(false);
    // A different conversation starts empty — the allowlist is per session.
    expect(binding({ sessionKey: conversationIdFor(USER, "other") }).isToolAllowed("Bash")).toBe(
      false,
    );
  });

  it("onSessionClosed denies the pending prompt instead of leaving it hanging", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    b.onSessionClosed();
    await expect(answer).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.pendingCount()).toBe(0);
    // ...and the allowlist is forgotten with the session.
    expect(b.isToolAllowed("Bash")).toBe(false);
  });
});

describe("audit trail", () => {
  it("writes a pending row BEFORE the user answers, then the decision", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });

    // Synchronous side of onPermission has already run: the audit knows the
    // call exists even if the browser never answers.
    const [pendingRow] = listToolCalls(db, KEY);
    expect(pendingRow).toMatchObject({
      toolUseId: "tu-1",
      name: "Bash",
      input: { command: "ls" },
      status: "pending",
      decidedBy: null,
    });

    broker.resolve(USER, "req-1", "allow");
    await answer;
    const [decided] = listToolCalls(db, KEY);
    expect(decided.status).toBe("allowed");
    expect(decided.decidedBy).toBe(USER);
    expect(listToolCalls(db, KEY)).toHaveLength(1);
  });

  it("records a denial — the audit shows what the user refused", async () => {
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    broker.resolve(USER, "req-1", "deny");
    await answer;
    const [row] = listToolCalls(db, KEY);
    expect(row.status).toBe("denied");
    expect(row.input).toEqual({ command: "ls" });
  });

  it("records a timeout (broker's deny) as a denial", async () => {
    const fast = new PermissionBroker({ timeoutMs: 1 });
    const b = createSessionBinding({
      userId: USER,
      sessionKey: KEY,
      conversationId: KEY,
      db,
      broker: fast,
    });
    const answer = await b.onPermission({ ...REQ });
    expect(answer).toMatchObject({ behavior: "deny" });
    expect(listToolCalls(db, KEY)[0].status).toBe("denied");
  });

  it("attaches the tool result to the audited call (status ok)", async () => {
    const b = binding();
    const listeners: Array<(e: TurnEvent) => void> = [];
    const session = {
      onEvent: (cb: (event: TurnEvent) => void) => void listeners.push(cb),
    };
    b.attach(session);

    const answer = b.onPermission({ ...REQ });
    broker.resolve(USER, "req-1", "allow");
    await answer;
    expect(listToolCalls(db, KEY)[0].status).toBe("allowed");

    for (const cb of listeners) {
      cb({ type: "tool_end", id: "tu-1", ok: true, output: "a.txt" });
    }
    const [row] = listToolCalls(db, KEY);
    expect(row.status).toBe("ok");
    expect(row.result).toEqual({ ok: true, output: "a.txt" });
  });

  it("ignores tool results for calls the gate never saw", async () => {
    const b = binding();
    const listeners: Array<(e: TurnEvent) => void> = [];
    b.attach({
      onEvent: (cb: (event: TurnEvent) => void) => void listeners.push(cb),
    });
    for (const cb of listeners) {
      cb({ type: "tool_end", id: "ghost", ok: true, output: "" });
    }
    expect(listToolCalls(db, KEY)).toHaveLength(0);
  });

  it("attaches exactly one listener per live session, even across turns", () => {
    // Session hooks are bound at creation, but the audit listener rides the
    // returned session object — a second turn on a REUSED session must not
    // stack a second listener (it would double every write forever).
    const first = binding();
    const listeners: Array<(e: TurnEvent) => void> = [];
    const session = {
      onEvent: (cb: (event: TurnEvent) => void) => void listeners.push(cb),
    };
    first.attach(session);
    first.attach(session);
    // Turn 2 builds a fresh binding from the same key (as the route does).
    binding().attach(session);
    expect(listeners).toHaveLength(1);
    expect(attachedSessionCountForTest()).toBe(1);

    // A NEW session object (evicted, then reopened) gets a listener of its own.
    const reopened: Array<(e: TurnEvent) => void> = [];
    binding().attach({
      onEvent: (cb: (event: TurnEvent) => void) => void reopened.push(cb),
    });
    expect(reopened).toHaveLength(1);
    expect(attachedSessionCountForTest()).toBe(2);
  });

  it("a failing audit write never changes the user's answer", async () => {
    // No conversation row → the FK rejects every audit write. The click must
    // still be honoured: the audit is a record, not a gate. (Fail-closed here
    // would deny a tool the user explicitly approved.)
    db.prepare("DELETE FROM tool_calls").run();
    db.prepare("DELETE FROM conversations").run();
    const b = binding();
    const answer = b.onPermission({ ...REQ });
    broker.resolve(USER, "req-1", "allow");
    await expect(answer).resolves.toEqual({ behavior: "allow" });
  });
});
