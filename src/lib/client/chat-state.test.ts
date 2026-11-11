import { describe, it, expect } from "vitest";
import {
  chatStateReducer,
  initialChatState,
  chatBootstrapSchema,
} from "./chat-state";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * chatStateReducer: the dispatch surface ChatColumn hands to useReducer.
 * Two actions only — a user message (view→view, closes open turns) and a
 * turn event (the stream). Everything else is chat-view's contract.
 */

const END: TurnEvent = {
  type: "turn_end",
  reason: "done",
  model: "sonnet",
  durationMs: 1,
  costUsd: 0.01,
  tokens: { input: 1, output: 1 },
  error: null,
};

describe("chatStateReducer", () => {
  it("pushes a user message and opens the starting state", () => {
    const v = chatStateReducer(initialChatState(), {
      type: "user_message",
      text: "hi",
    });
    expect(v.running).toBe(true);
    expect(v.started).toBe(false);
    expect(v.turns).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("reduces turn events unchanged", () => {
    let v = chatStateReducer(initialChatState(), {
      type: "user_message",
      text: "hi",
    });
    v = chatStateReducer(v, {
      type: "turn_event",
      event: { type: "text_delta", text: "Hello" },
    });
    v = chatStateReducer(v, { type: "turn_event", event: END });
    expect(v.running).toBe(false);
    expect(v.turns).toHaveLength(2);
  });

  it("a user message closes a still-open turn as an error (reconnect case)", () => {
    let v = chatStateReducer(initialChatState(), {
      type: "user_message",
      text: "one",
    });
    v = chatStateReducer(v, {
      type: "turn_event",
      event: { type: "text_delta", text: "partial" },
    });
    v = chatStateReducer(v, { type: "user_message", text: "two" });
    const first = v.turns.find(
      (t) => t.kind === "assistant",
    ) as { end: { reason: string; error: string } } | undefined;
    expect(first?.end.reason).toBe("error");
    expect(first?.end.error).toMatch(/connection/i);
  });
});

describe("chatBootstrapSchema", () => {
  it("passes through a well-formed bootstrap payload", () => {
    const payload = {
      roots: ["/w"],
      defaultModel: "auto",
      providers: [
        {
          id: "claude",
          capabilities: {
            interactiveToolPrompts: true,
            sessionResume: true,
            partialText: true,
            skills: "native",
            plugins: true,
          },
          installed: true,
          version: null,
          authed: null,
          reason: null,
          models: [{ id: "auto", label: "Auto (CLI default)" }],
        },
      ],
    };
    expect(chatBootstrapSchema(payload)).toEqual(payload);
  });

  it("rejects a payload that is not the bootstrap shape", () => {
    expect(() => chatBootstrapSchema({ roots: "no" })).toThrow();
    expect(() => chatBootstrapSchema(null)).toThrow();
    expect(() =>
      chatBootstrapSchema({ roots: [], defaultModel: "auto", providers: {} }),
    ).toThrow();
    expect(() => chatBootstrapSchema("")).toThrow();
  });
});
