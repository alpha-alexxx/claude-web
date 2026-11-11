"use client";

import { useCallback, useMemo, useState, useReducer } from "react";
import { toast } from "sonner";
import {
  chatStateReducer,
  initialChatState,
  type ChatBootstrap,
} from "@/lib/client/chat-state";
import type { TurnEvent } from "@/lib/providers/types";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { ModelPicker } from "./model-picker";
import { CwdPicker } from "./cwd-picker";

/**
 * ChatColumn: owns one conversation's TurnView via chatStateReducer and
 * glues the pure pieces together — transport, transcript, composer, pickers.
 *
 * The conversation id is client-generated (crypto.randomUUID) until Phase 5
 * persistence lands; the server pool is keyed user-scoped upstream
 * (userId:conversationId), so any client string is safe.
 *
 * The Stop button hits POST /api/chat/[id]/stop. It is fire-and-forget: the
 * CLI's interrupt lands as a turn_end on the still-open event stream, which
 * is what actually flips running=false — no polling, no second state path.
 */

export function ChatColumn({ bootstrap }: { bootstrap: ChatBootstrap }) {
  const [view, dispatch] = useReducer(chatStateReducer, initialChatState());
  const [conversationId] = useState(() => crypto.randomUUID());
  // v1 composer offers one provider (claude); the picker arrives with the
  // adapter increments — bootstrap.providers[0] is already the enabled set.
  const [provider] = useState(
    bootstrap.providers.length > 0 ? bootstrap.providers[0].id : "claude",
  );
  const [model, setModel] = useState(bootstrap.defaultModel);
  const [cwd, setCwd] = useState(bootstrap.roots[0] ?? "");

  const models = useMemo(
    () =>
      bootstrap.providers.find((p) => p.id === provider)?.models ?? [],
    [bootstrap.providers, provider],
  );

  const onEvent = useCallback((event: TurnEvent) => {
    dispatch({ type: "turn_event", event });
  }, []);

  const onBeforeSend = useCallback((text: string) => {
    dispatch({ type: "user_message", text });
  }, []);

  const onStop = useCallback(async () => {
    try {
      const res = await fetch(`/api/chat/${conversationId}/stop`, {
        method: "POST",
      });
      if (!res.ok && res.status !== 404) {
        toast.error("Stop failed — the turn may have already ended.");
      }
    } catch {
      toast.error("Stop request failed — network error.");
    }
  }, [conversationId]);

  const onModelChange = useCallback(
    async (next: string) => {
      setModel(next);
      // Best-effort live switch (ledgered: swallowed server-side when a
      // turn is mid-flight; the next POST carries the model anyway).
      try {
        await fetch(`/api/chat/${conversationId}/model`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: next, provider }),
        });
      } catch {
        /* swallowed by design */
      }
    },
    [conversationId, provider],
  );

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
      <main
        role="log"
        aria-live="polite"
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        <MessageList view={view} />
      </main>
      <footer className="border-t border-border px-4 py-3">
        <Composer
          conversationId={conversationId}
          provider={provider}
          cwd={cwd}
          model={model}
          resumeSessionId={null}
          running={view.running}
          onEvent={onEvent}
          onBeforeSend={onBeforeSend}
          onStop={() => void onStop()}
        />
      </footer>
    </div>
  );
}
