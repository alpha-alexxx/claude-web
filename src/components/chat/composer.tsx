"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runTurn } from "@/lib/client/turn-client";
import type { TurnEvent } from "@/lib/providers/types";

/**
 * Composer: the single place a turn is started. Wraps runTurn — the transport
 * resolves on every path including failures (ledgered), so the composer has
 * no error branch of its own; the stream carries an error turn_end instead.
 *
 * The reducer owns all chat state; the composer only fires the POST and
 * forwards events to onEvent.
 */

export interface ComposerProps {
  conversationId: string;
  provider: string;
  cwd: string;
  model: string | null;
  running: boolean;
  onEvent: (event: TurnEvent) => void;
  /** Push the trimmed user message into the transcript before the POST. */
  onBeforeSend: (text: string) => void;
  /** The server accepted the turn; the conversation row now exists. */
  onAccepted?: () => void;
  onStop: () => void;
}

export function Composer(props: ComposerProps) {
  const { running, onBeforeSend: pushUserMessage, onEvent, onStop } = props;
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    pushUserMessage(trimmed);
    void runTurn({
      conversationId: props.conversationId,
      provider: props.provider,
      cwd: props.cwd,
      text: trimmed,
      model: props.model ?? undefined,
      onEvent,
      onAccepted: props.onAccepted,
    });
    setText("");
    areaRef.current?.focus();
  }, [
    text,
    running,
    // `trimmed` is derived from `text`, which is already a dependency.
    onEvent,
    pushUserMessage,
    props.conversationId,
    props.provider,
    props.cwd,
    props.model,
  ]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex items-end gap-2">
      <Textarea
        ref={areaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Message the agent… (Enter to send, Shift+Enter for newline)"
        aria-label="Message the agent"
        className="min-h-11 max-h-64 resize-none bg-secondary"
        rows={1}
      />
      {running ? (
        <Button
          variant="outline"
          onClick={onStop}
          aria-label="Stop the running turn"
        >
          Stop
        </Button>
      ) : (
        <Button onClick={send} disabled={!text.trim()} aria-label="Send message">
          Send
        </Button>
      )}
    </div>
  );
}
