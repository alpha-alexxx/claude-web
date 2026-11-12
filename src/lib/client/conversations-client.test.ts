import { describe, it, expect, vi } from "vitest";
import {
  deleteConversation,
  listConversations,
  renameConversation,
  type ConversationSummary,
} from "./conversations-client";

/**
 * conversations-client: the sidebar's browser half of /api/conversations.
 *
 * Contract pinned:
 * - ids are URL-encoded (a client id is opaque; it must never reshape a path)
 * - rename sends exactly `{ title }` and trims NOTHING itself — the server
 *   owns trimming and length policy, so the two cannot disagree
 * - every call resolves (never rejects): a sidebar that throws into an
 *   unhandled rejection breaks the whole chat surface for a list refresh
 * - failures carry the server's error code so the UI can say something true
 */

const ROW: ConversationSummary = {
  id: "abc",
  title: "Hello",
  provider: "claude",
  model: null,
  cwd: "/w",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("listConversations", () => {
  it("returns the parsed list", async () => {
    const f = vi.fn(async () => jsonResponse({ conversations: [ROW] }));
    const result = await listConversations({ fetch: f });
    expect(result).toEqual({ ok: true, conversations: [ROW] });
    expect(f).toHaveBeenCalledWith("/api/conversations", expect.anything());
  });

  it("resolves to a failure on a network error instead of throwing", async () => {
    const f = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await listConversations({ fetch: f });
    expect(result.ok).toBe(false);
    expect(result.conversations).toEqual([]);
  });

  it("resolves to a failure on a malformed payload", async () => {
    const f = vi.fn(async () => jsonResponse({ conversations: "nope" }));
    const result = await listConversations({ fetch: f });
    expect(result.ok).toBe(false);
    expect(result.conversations).toEqual([]);
  });
});

describe("renameConversation", () => {
  it("PATCHes an encoded id with the title verbatim", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true, title: "x" }));
    const result = await renameConversation("a/b c", "  spaced  ", { fetch: f });
    expect(result.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/conversations/a%2Fb%20c");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "  spaced  " });
  });

  it("reports the server's error code on rejection", async () => {
    const f = vi.fn(async () => jsonResponse({ error: "invalid_body" }, 400));
    const result = await renameConversation("a", "", { fetch: f });
    expect(result).toEqual({ ok: false, code: "invalid_body" });
  });
});

describe("deleteConversation", () => {
  it("DELETEs an encoded id", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    const result = await deleteConversation("a b", { fetch: f });
    expect(result.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/conversations/a%20b");
    expect(init.method).toBe("DELETE");
  });

  it("turns a transport failure into a failure result", async () => {
    const f = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await deleteConversation("a", { fetch: f });
    expect(result).toEqual({ ok: false, code: "network" });
  });
});
