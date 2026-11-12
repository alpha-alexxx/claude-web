"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useReducer } from "react";
import { toast } from "sonner";
import {
  chatStateReducer,
  initialChatState,
  type ChatBootstrap,
} from "@/lib/client/chat-state";
import type { TurnEvent } from "@/lib/providers/types";
import type { PermissionDecision, TurnView } from "@/lib/client/chat-view";
import { answerPermission } from "@/lib/client/turn-client";
import { emitConversationsChanged } from "@/lib/client/conversation-events";
import { useMounted } from "@/lib/client/use-mounted";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { ModelPicker } from "./model-picker";
import { CwdPicker } from "./cwd-picker";

/**
 * ChatColumn: owns one conversation's TurnView via chatStateReducer and
 * glues the pure pieces together — transport, transcript, composer, pickers.
 *
 * The conversation id is CLIENT-shaped — `crypto.randomUUID()` for a new
 * chat — but never a database address: the server prefixes it with the
 * caller's id before it reaches the pool or the `conversations` row.
 * /chat/[id] passes the id it was opened with, so a turn sent from a
 * replayed conversation lands on the same row.
 *
 * URL settle: a new conversation keeps /chat (no id exists to show) and
 * replaceStates to /chat/<id> just before the first turn is sent — REPLACE,
 * not push, because /chat and /chat/<id> are the same conversation; pushing
 * would make Back undo the first message. The id is minted on mount via a
 * lazy initializer so the composer has a stable value from frame one, and
 * `useMounted` gates the replace so the address bar is only touched in the
 * browser. Next.js integrates replaceState with its router (app-router.js
 * patches history), so usePathname-based active states in the sidebar
 * follow without a router.push — which would remount this streaming
 * component and tear the turn down underneath it.
 *
 * After every turn ends, the column announces it once: the chat route wrote
 * the row server-side, and the sidebar can only learn of it by refetching.
 *
 * `initialView` is history, not state to resume: the reducer seeds from it and
 * the server's own `cli_session_id` is what makes the next turn continue the
 * CLI conversation. Nothing here (and nothing on the wire) carries a resume
 * target.
 *
 * The Stop button hits POST /api/chat/[id]/stop. It is fire-and-forget: the
 * CLI's interrupt lands as a turn_end on the still-open event stream, which
 * is what actually flips running=false — no polling, no second state path.
 */

export interface ChatColumnProps {
  bootstrap: ChatBootstrap;
  /** A client-shaped id: new-chat minted on the client, replay id from the URL. */
  conversationId?: string;
  /** Replayed history for an existing conversation; absent for a new one. */
  initialView?: TurnView;
  /** Persisted choices, so a reopened conversation resumes its own setup. */
  initialCwd?: string | null;
  initialModel?: string | null;
  initialProvider?: string | null;
}

export function ChatColumn({
  bootstrap,
  conversationId,
  initialView,
  initialCwd,
  initialModel,
  initialProvider,
}: ChatColumnProps) {
  const mounted = useMounted();

  // Lazy initializer: one id per component instance, stable across renders.
  // A prop id (replay) wins; otherwise mint a fresh uuid for a new chat.
  const [id] = useState(() => conversationId ?? crypto.randomUUID());

  const [view, dispatch] = useReducer(
    chatStateReducer,
    initialView,
    (seed) => seed ?? initialChatState(),
  );

  // The provider must be one the bootstrap actually offers: a stored row can
  // name a provider that has since been disabled, and the composer must not
  // be able to POST it.
  const [provider] = useState(() => {
    const offered = bootstrap.providers.find((p) => p.id === initialProvider);
    if (offered) return offered.id;
    return bootstrap.providers.length > 0 ? bootstrap.providers[0].id : "claude";
  });

  const [model, setModel] = useState(
    initialModel ?? bootstrap.defaultModel,
  );

  // A persisted cwd that is no longer inside the roots (config changed since
  // the conversation was written) falls back to the first allowed root — the
  // server would reject it anyway, so offering it would be a lie.
  const [cwd, setCwd] = useState(() => {
    if (initialCwd && bootstrap.roots.includes(initialCwd)) return initialCwd;
    return bootstrap.roots[0] ?? "";
  });

  const models = useMemo(
    () =>
      bootstrap.providers.find((p) => p.id === provider)?.models ?? [],
    [bootstrap.providers, provider],
  );

  // URL settle: /chat → /chat/<id> exactly once, on the server's ACCEPTANCE of
  // the first turn — not on mount (/chat/<id> for a row that does not exist
  // yet would 404 on reload) and not on the first event (a slow first token
  // would leave a message already sent sitting on the wrong URL). Settled ref
  // so it cannot replace twice; replayed conversations arrive already correct.
  const settledUrl = useRef(conversationId !== undefined);
  const settleUrl = useCallback(() => {
    if (!mounted || settledUrl.current) return;
    settledUrl.current = true;
    window.history.replaceState(null, "", `/chat/${encodeURIComponent(id)}`);
  }, [mounted, id]);

  const onEvent = useCallback((event: TurnEvent) => {
    dispatch({ type: "turn_event", event });
  }, []);

  const onBeforeSend = useCallback((text: string) => {
    dispatch({ type: "user_message", text });
  }, []);

  /**
   * Answer a permission card. The reducer flips it to answered immediately
   * (optimistic — the card must stop looking clickable while the POST is in
   * flight); a failed answer is surfaced but left answered, because the
   * broker's 5-minute timeout is what settles the CLI call either way and
   * re-opening the card would invite a second, conflicting answer.
   */
  const onAnswerPermission = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      dispatch({ type: "permission_answered", requestId, decision });
      const result = await answerPermission({ requestId, decision });
      if (!result.ok) {
        toast.error(
          result.code === "not_found"
            ? "This request already expired or was answered elsewhere."
            : "Could not deliver your answer — the tool was denied by timeout.",
        );
      }
    },
    [],
  );

  const onStop = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/${id}/stop`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 404) {
        toast.error("Stop failed — the turn may have already ended.");
      }
    } catch {
      toast.error("Stop request failed — network error.");
    }
  }, [id]);

  const onModelChange = useCallback(
    async (next: string) => {
      setModel(next);
      // Best-effort live switch (ledgered: swallowed server-side when a
      // turn is mid-flight; the next POST carries the model anyway).
      try {
        await fetch(`/api/chat/${id}/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: next, provider }),
        });
      } catch {
        /* swallowed by design */
      }
    },
    [id, provider],
  );

  // Announce turn completion so the sidebar refetches once. The effect fires
  // on every transition OUT of running (done, error, interrupted — the exact
  // writes the chat route made), and never on mount (running starts false,
  // and a ref guard skips the first settled render).
  const announcedTurn = useRef(true);
  useEffect(() => {
    if (view.running) {
      announcedTurn.current = false;
      return;
    }
    if (!announcedTurn.current) {
      announcedTurn.current = true;
      emitConversationsChanged();
    }
  }, [view.running]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <ModelPicker
          models={models}
          value={model}
          onChange={(m) => void onModelChange(m)}
        />
        <CwdPicker roots={bootstrap.roots} value={cwd} onChange={setCwd} />
        <span className="ml-auto text-xs text-muted-foreground">
          {provider}
        </span>
      </header>
      {/* MessageList owns the live region (role="log", labelled): this
          wrapper must NOT repeat it — nested live regions make a screen
          reader announce the same appended text twice. */}
      <main className="flex-1 overflow-y-auto px-4 py-4">
        <MessageList
          view={view}
          // Read-only history in replay: the answer route only knows live
          // requests, so offering buttons on an old card would be a dead end.
          onAnswerPermission={
            view.running
              ? (requestId, decision) =>
                  void onAnswerPermission(requestId, decision)
              : undefined
          }
        />
      </main>
      <footer className="border-t border-border px-4 py-3">
        <Composer
          conversationId={id}
          provider={provider}
          cwd={cwd}
          model={model}
          running={view.running}
          onEvent={onEvent}
          onBeforeSend={onBeforeSend}
          onAccepted={settleUrl}
          onStop={() => void onStop()}
        />
      </footer>
    </div>
  );
}
