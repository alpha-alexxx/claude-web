import {
  initialView,
  pushUserMessage,
  reduceTurnEvent,
  type TurnView,
} from "./chat-view";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * chatState: the reducer ChatColumn feeds to useReducer. It exists because
 * useReducer consumes ACTIONS and the view-model API is event-shaped:
 * pushUserMessage is view→view (it closes an open turn as a connection
 * error — a synthesizable state change), while reduceTurnEvent is
 * view×event→view. One discriminated union wraps both so React keeps a
 * single dispatch surface (dispatch is stable across renders; callbacks
 * that only dispatch don't re-subscribe or re-render children).
 *
 * /api/bootstrap payload shape lives here too (ChatBootstrap) — pure data,
 * shared by the page (server: fetches it) and ChatColumn (consumes it).
 */

export type ChatAction =
  | { type: "user_message"; text: string }
  | { type: "turn_event"; event: TurnEvent };

export function chatBootstrapSchema(raw: unknown): ChatBootstrap {
  const payload = raw as ChatBootstrap;
  if (
    !Array.isArray(payload.roots) ||
    typeof payload.defaultModel !== "string" ||
    !Array.isArray(payload.providers)
  ) {
    throw new Error("bootstrap payload has an unexpected shape");
  }
  return payload;
}

export interface ChatBootstrapProvider {
  id: string;
  capabilities: {
    interactiveToolPrompts: boolean;
    sessionResume: boolean;
    partialText: boolean;
    skills: string;
    plugins: boolean;
  };
  installed: boolean;
  version: string | null;
  authed: boolean | null;
  reason: string | null;
  models: Array<{ id: string; label: string | null }>;
}

export interface ChatBootstrap {
  roots: string[];
  defaultModel: string;
  providers: ChatBootstrapProvider[];
}

export function chatStateReducer(
  view: TurnView,
  action: ChatAction,
): TurnView {
  switch (action.type) {
    case "user_message":
      return pushUserMessage(view, action.text);
    case "turn_event":
      return reduceTurnEvent(view, action.event);
  }
}

export function initialChatState(): TurnView {
  return initialView();
}
