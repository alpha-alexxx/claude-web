import { describe, it, expect, vi } from "vitest";
import {
  createConversationListStore,
  type ConversationListTransport,
} from "./conversation-list-store";
import type { ConversationSummary } from "@/lib/chat/conversation-view";

/**
 * conversation-list-store: ONE conversation list, shared by the desktop
 * sidebar and the mobile sheet's copy.
 *
 * Contract pinned:
 * - nothing is known before the first load settles (rows === null → skeleton)
 * - a failed load never empties a list that was already known
 * - concurrent refreshes (focus + pathname + turn-end) share one request
 * - rename is optimistic but rolls back ONLY that row, and only if no newer
 *   truth arrived while the request was in flight
 * - "not_found" counts as gone: dropping the row is the truth
 * - the server snapshot is always pristine — the store is a module singleton,
 *   so it must never leak one request's data into another's SSR output
 */

const row = (id: string, title: string | null = id): ConversationSummary => ({
  id,
  title,
  provider: "claude",
  model: null,
  cwd: "/w",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeTransport(
  overrides: Partial<ConversationListTransport> = {},
): ConversationListTransport {
  return {
    list: vi.fn(async () => ({ ok: true, conversations: [] })),
    rename: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe("createConversationListStore", () => {
  it("starts unknown: no rows, no failure", () => {
    const store = createConversationListStore(fakeTransport());
    expect(store.getSnapshot()).toEqual({ rows: null, loadFailed: false });
  });

  it("publishes rows and notifies subscribers when a load succeeds", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: true, conversations: [row("a")] })),
    });
    const store = createConversationListStore(transport);
    const listener = vi.fn();
    store.subscribe(listener);

    await store.refresh();

    expect(store.getSnapshot()).toEqual({
      rows: [row("a")],
      loadFailed: false,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports a first-load failure as an empty list that failed", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: false, conversations: [] })),
    });
    const store = createConversationListStore(transport);

    await store.refresh();

    expect(store.getSnapshot()).toEqual({ rows: [], loadFailed: true });
  });

  it("keeps a known list when a later load fails", async () => {
    let ok = true;
    const transport = fakeTransport({
      list: vi.fn(async () =>
        ok
          ? { ok: true, conversations: [row("a")] }
          : { ok: false, conversations: [] },
      ),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    ok = false;
    await store.refresh();

    expect(store.getSnapshot()).toEqual({
      rows: [row("a")],
      loadFailed: true,
    });
  });

  it("shares one request between concurrent refreshes", async () => {
    const pending = deferred<{ ok: boolean; conversations: ConversationSummary[] }>();
    const transport = fakeTransport({ list: vi.fn(() => pending.promise) });
    const store = createConversationListStore(transport);

    const first = store.refresh();
    const second = store.refresh();

    expect(transport.list).toHaveBeenCalledTimes(1);

    pending.resolve({ ok: true, conversations: [row("a")] });
    await Promise.all([first, second]);

    expect(store.getSnapshot().rows).toEqual([row("a")]);
  });

  it("treats a throwing transport as a failed load", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const store = createConversationListStore(transport);

    await store.refresh();

    expect(store.getSnapshot()).toEqual({ rows: [], loadFailed: true });
  });

  it("applies a rename optimistically, before the request settles", async () => {
    const pending = deferred<{ ok: boolean }>();
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: true, conversations: [row("a", "old")] })),
      rename: vi.fn(() => pending.promise),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    const rename = store.rename("a", "new");
    expect(store.getSnapshot().rows?.[0].title).toBe("new");

    pending.resolve({ ok: true });
    await rename;
    expect(store.getSnapshot().rows?.[0].title).toBe("new");
  });

  it("rolls a failed rename back to that row's previous title only", async () => {
    const pending = deferred<{ ok: boolean; code: string }>();
    const transport = fakeTransport({
      list: vi.fn(async () => ({
        ok: true,
        conversations: [row("a", "old-a"), row("b", "old-b")],
      })),
      rename: vi.fn(() => pending.promise),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    const rename = store.rename("a", "new-a");
    pending.resolve({ ok: false, code: "network" });
    await rename;

    expect(store.getSnapshot().rows?.map((r) => r.title)).toEqual([
      "old-a",
      "old-b",
    ]);
  });

  it("keeps a newer title that arrived while a rename was in flight", async () => {
    const renamePending = deferred<{ ok: boolean; code: string }>();
    let listCalls = 0;
    const transport = fakeTransport({
      list: vi.fn(async () => {
        listCalls += 1;
        return {
          ok: true,
          conversations: [
            listCalls === 1 ? row("a", "old") : row("a", "renamed-elsewhere"),
          ],
        };
      }),
      rename: vi.fn(() => renamePending.promise),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    const rename = store.rename("a", "mine");
    await store.refresh(); // newer truth lands mid-flight
    renamePending.resolve({ ok: false, code: "network" });
    await rename;

    // The rollback must not resurrect a title the server has already replaced.
    expect(store.getSnapshot().rows?.[0].title).toBe("renamed-elsewhere");
  });

  it("drops a row on delete and on a not_found delete", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({
        ok: true,
        conversations: [row("a"), row("b")],
      })),
      remove: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, code: "not_found" }),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    await store.remove("a");
    expect(store.getSnapshot().rows?.map((r) => r.id)).toEqual(["b"]);

    const result = await store.remove("b");
    expect(store.getSnapshot().rows).toEqual([]);
    // Gone is gone: the caller must navigate away, same as a real delete.
    expect(result).toEqual({ ok: true });
  });

  it("keeps the row when a delete fails for another reason", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: true, conversations: [row("a")] })),
      remove: vi.fn(async () => ({ ok: false, code: "network" })),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    const result = await store.remove("a");

    expect(result).toEqual({ ok: false, code: "network" });
    expect(store.getSnapshot().rows?.map((r) => r.id)).toEqual(["a"]);
  });

  it("stops notifying after the last unsubscribe", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: true, conversations: [row("a")] })),
    });
    const store = createConversationListStore(transport);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    await store.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  it("never serves live state as the server snapshot", async () => {
    const transport = fakeTransport({
      list: vi.fn(async () => ({ ok: true, conversations: [row("a")] })),
    });
    const store = createConversationListStore(transport);
    await store.refresh();

    expect(store.getServerSnapshot()).toEqual({ rows: null, loadFailed: false });
  });
});
