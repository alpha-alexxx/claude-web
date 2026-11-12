import type { ConversationSummary } from "@/lib/chat/conversation-view";
import {
  deleteConversation,
  listConversations,
  renameConversation,
  type MutationResult,
} from "./conversations-client";

/**
 * conversation-list-store: ONE conversation list, subscribed to from anywhere.
 *
 * The shell renders the list twice — the always-visible desktop column and the
 * mobile sheet — and Radix portals the sheet only while it is open, so the two
 * copies do not exist at once by luck of mounting: they overlap for as long as
 * the sheet is open. Two independent instances would mean two fetches, and a
 * rename or delete in one invisible in the other until a refetch. So the list
 * lives here, once, and both sides render the same snapshot.
 *
 * It is a `useSyncExternalStore` store, which is why the snapshots have three
 * rules:
 *   - `getSnapshot` returns the SAME object until something changes (a new
 *     object every call is an infinite re-render loop);
 *   - `getServerSnapshot` returns pristine state, never live rows — this
 *     module is a browser singleton, and serving one visitor's rows as
 *     another's SSR output would be a data leak, not a hydration mismatch;
 *   - subscribers are told only on a real change.
 *
 * Refresh is deduplicated: focus, navigation, and a finished turn all ask for
 * the same thing within the same tick, and they should cost one request.
 */

export interface ConversationListSnapshot {
  /**
   * `null` means "not loaded yet" — the skeleton state. Once a load has
   * settled it is always an array, even after a failure: a list that was
   * known must never be replaced by a blank one, which reads as "your
   * conversations are gone".
   */
  rows: ConversationSummary[] | null;
  loadFailed: boolean;
}

export interface ConversationListTransport {
  list(): Promise<{ ok: boolean; conversations: ConversationSummary[] }>;
  rename(id: string, title: string): Promise<MutationResult>;
  remove(id: string): Promise<MutationResult>;
}

export interface ConversationListStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConversationListSnapshot;
  getServerSnapshot(): ConversationListSnapshot;
  /** Refetch the list. Concurrent calls share one request. */
  refresh(): Promise<void>;
  /** Optimistically retitle one row; rolls back only that row on failure. */
  rename(id: string, title: string): Promise<MutationResult>;
  /**
   * Delete one row. Resolves `ok: true` when the row is gone — including when
   * the server says `not_found`, because gone is gone either way and the
   * caller must navigate off a conversation that no longer exists.
   */
  remove(id: string): Promise<MutationResult>;
}

const INITIAL: ConversationListSnapshot = Object.freeze({
  rows: null,
  loadFailed: false,
});

export function createConversationListStore(
  transport: ConversationListTransport,
): ConversationListStore {
  let snapshot: ConversationListSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let inFlight: Promise<void> | null = null;

  const publish = (next: ConversationListSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const applyLoad = (result: Awaited<ReturnType<ConversationListTransport["list"]>>) => {
    if (result.ok) {
      publish({ rows: result.conversations, loadFailed: false });
      return;
    }
    publish({
      // Keep whatever we had on a transient failure; only a first load has
      // nothing to keep.
      rows: snapshot.rows ?? [],
      loadFailed: true,
    });
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        applyLoad(await transport.list());
      } catch {
        applyLoad({ ok: false, conversations: [] });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const rename = async (id: string, title: string): Promise<MutationResult> => {
    const previousTitle =
      snapshot.rows?.find((r) => r.id === id)?.title ?? null;
    if (snapshot.rows) {
      publish({
        ...snapshot,
        rows: snapshot.rows.map((r) => (r.id === id ? { ...r, title } : r)),
      });
    }

    let result: MutationResult;
    try {
      result = await transport.rename(id, title);
    } catch {
      result = { ok: false, code: "network" };
    }

    if (!result.ok) {
      // Roll back ONLY this row, and only if it still holds our optimistic
      // title. A refresh may have delivered a newer title mid-flight; undoing
      // that would put a stale value back on screen.
      const rows = snapshot.rows;
      if (rows) {
        const current = rows.find((r) => r.id === id);
        if (current && current.title === title) {
          publish({
            ...snapshot,
            rows: rows.map((r) =>
              r.id === id ? { ...r, title: previousTitle } : r,
            ),
          });
        }
      }
    }
    return result;
  };

  const remove = async (id: string): Promise<MutationResult> => {
    let result: MutationResult;
    try {
      result = await transport.remove(id);
    } catch {
      result = { ok: false, code: "network" };
    }

    if (result.ok || result.code === "not_found") {
      if (snapshot.rows) {
        publish({
          ...snapshot,
          rows: snapshot.rows.filter((r) => r.id !== id),
        });
      }
      return { ok: true };
    }
    return result;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL,
    refresh,
    rename,
    remove,
  };
}

/**
 * The app's single list instance. One per browser tab, created on first
 * import — a module singleton rather than context because the desktop column
 * and the mobile sheet live in different subtrees (the sheet is portalled).
 */
export const conversationListStore = createConversationListStore({
  list: () => listConversations(),
  rename: (id, title) => renameConversation(id, title),
  remove: (id) => deleteConversation(id),
});
