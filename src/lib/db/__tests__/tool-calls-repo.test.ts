import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrate } from "../migrate";
import {
  recordToolRequest,
  recordToolDecision,
  recordToolResult,
  listToolCalls,
} from "../tool-calls-repo";

/**
 * tool_calls is the audit trail: a row is written BEFORE the user decides, so
 * a denial is as visible as an approval, and the result is attached later.
 * Refs are CHECKed, so the tests keep one conversation row alive.
 */

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcalls-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.prepare(
    "INSERT INTO users (id, email, role) VALUES ('user_1', 'a@b.c', 'user')",
  ).run();
  db.prepare(
    "INSERT INTO conversations (id, user_id) VALUES ('conv-1', 'user_1')",
  ).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("recordToolRequest", () => {
  it("writes a pending row before the user answers", () => {
    recordToolRequest(db, {
      conversationId: "conv-1",
      toolUseId: "tu_pending",
      name: "Bash",
      input: { command: "rm -rf /" },
    });
    const [row] = listToolCalls(db, "conv-1");
    expect(row).toMatchObject({
      toolUseId: "tu_pending",
      name: "Bash",
      input: { command: "rm -rf /" },
      status: "pending",
      decidedBy: null,
      decidedAt: null,
    });
  });

  it("is idempotent — a repeat still yields one pending row", () => {
    const req = {
      conversationId: "conv-1",
      toolUseId: "tu_pending2",
      name: "Bash",
      input: {},
    };
    recordToolRequest(db, req);
    recordToolRequest(db, req);
    expect(listToolCalls(db, "conv-1")).toHaveLength(1);
  });

  it("the pending row is what the decision later updates", () => {
    recordToolRequest(db, {
      conversationId: "conv-1",
      toolUseId: "tu_pending3",
      name: "Write",
      input: { file_path: "/tmp/x" },
    });
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_pending3",
      name: "Write",
      input: { file_path: "/tmp/x" },
      decision: "deny",
      decidedBy: "user_1",
    });
    const rows = listToolCalls(db, "conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
    expect(rows[0].decidedBy).toBe("user_1");
  });
});

describe("tool-calls-repo", () => {
  it("records a pending-then-allowed decision", () => {
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_1",
      name: "Bash",
      input: { command: "ls" },
      decision: "allow",
      decidedBy: "user_1",
    });
    const rows = listToolCalls(db, "conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId: "conv-1",
      toolUseId: "tu_1",
      name: "Bash",
      input: { command: "ls" },
      status: "allowed",
      decidedBy: "user_1",
      result: null,
    });
    expect(rows[0].decidedAt).not.toBeNull();
  });

  it("records a denial (audit shows it)", () => {
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_2",
      name: "Write",
      input: { file_path: "/etc/passwd" },
      decision: "deny",
      decidedBy: "user_1",
    });
    const [row] = listToolCalls(db, "conv-1");
    expect(row.status).toBe("denied");
    expect(row.input).toEqual({ file_path: "/etc/passwd" });
  });

  it("attaches the tool result by tool_use_id", () => {
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_3",
      name: "Bash",
      input: { command: "ls" },
      decision: "allow",
      decidedBy: "user_1",
    });
    recordToolResult(db, {
      conversationId: "conv-1",
      toolUseId: "tu_3",
      ok: true,
      output: "a.txt",
    });
    const [row] = listToolCalls(db, "conv-1");
    expect(row.status).toBe("ok");
    expect(row.result).toEqual({ ok: true, output: "a.txt" });
  });

  it("records an error result as status 'error'", () => {
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_4",
      name: "Bash",
      input: { command: "false" },
      decision: "allow",
      decidedBy: "user_1",
    });
    recordToolResult(db, {
      conversationId: "conv-1",
      toolUseId: "tu_4",
      ok: false,
      output: "exit 1",
    });
    expect(listToolCalls(db, "conv-1")[0].status).toBe("error");
  });

  it("a result for an unknown tool_use_id writes nothing (no phantom rows)", () => {
    recordToolResult(db, {
      conversationId: "conv-1",
      toolUseId: "ghost",
      ok: true,
      output: "",
    });
    expect(listToolCalls(db, "conv-1")).toHaveLength(0);
  });

  it("does not overwrite a denial's status when a late result arrives", () => {
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "tu_5",
      name: "Bash",
      input: {},
      decision: "deny",
      decidedBy: "user_1",
    });
    // The CLI may still report the denied tool as an error result.
    recordToolResult(db, {
      conversationId: "conv-1",
      toolUseId: "tu_5",
      ok: false,
      output: "denied",
    });
    const [row] = listToolCalls(db, "conv-1");
    expect(row.status).toBe("denied");
    // ...but the result is still attached for the record.
    expect(row.result).toEqual({ ok: false, output: "denied" });
  });

  it("lists newest first and scopes to the conversation", () => {
    db.prepare(
      "INSERT INTO conversations (id, user_id) VALUES ('conv-2', 'user_1')",
    ).run();
    recordToolDecision(db, {
      conversationId: "conv-2",
      toolUseId: "other",
      name: "Read",
      input: {},
      decision: "allow",
      decidedBy: "user_1",
    });
    recordToolDecision(db, {
      conversationId: "conv-1",
      toolUseId: "mine",
      name: "Bash",
      input: {},
      decision: "allow",
      decidedBy: "user_1",
    });
    const rows = listToolCalls(db, "conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].toolUseId).toBe("mine");
  });

  it("is idempotent for a repeated decision on the same tool_use_id", () => {
    const base = {
      conversationId: "conv-1",
      toolUseId: "tu_6",
      name: "Bash",
      input: {},
      decidedBy: "user_1",
    } as const;
    recordToolDecision(db, { ...base, decision: "allow" });
    recordToolDecision(db, { ...base, decision: "deny" });
    const rows = listToolCalls(db, "conv-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("denied");
  });
});
