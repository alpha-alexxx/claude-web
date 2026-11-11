"use client";

import { useState } from "react";
import {
  type AssistantBlock,
  type AssistantTurn,
  type PermissionDecision,
  type TurnView,
  type UserTurn,
} from "@/lib/client/chat-view";
import { ToolCard } from "@/components/tools/tool-card";
import { PermissionCard } from "@/components/tools/permission-card";

/**
 * Transcript renderer: walks a TurnView and renders each turn. Pure mapping
 * from the view-model to JSX — no stream logic, no state beyond local
 * collapse toggles. aria-live receives appended text as it streams.
 *
 * Tool and permission rendering live in `components/tools/` so their
 * provider-derived shapes (diffs, terminal output, questions) can grow
 * without this file knowing about them.
 */

function UserMessage({ turn }: { turn: UserTurn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground">
        <p className="whitespace-pre-wrap break-words text-sm">{turn.text}</p>
      </div>
    </div>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        <span aria-hidden>💭</span>
        Thinking
        <span className="ml-auto">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      )}
    </div>
  );
}

type AnswerPermission = (requestId: string, decision: PermissionDecision) => void;

function Block({
  block,
  onAnswer,
}: {
  block: AssistantBlock;
  onAnswer?: AnswerPermission;
}) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap break-words text-sm">{block.text}</p>;
    case "thinking":
      return <ThinkingBlock text={block.text} />;
    case "tool":
      return <ToolCard tool={block.tool} />;
    case "permission":
      return <PermissionCard card={block.card} onAnswer={onAnswer} />;
  }
}

function AssistantMessage({
  turn,
  onAnswer,
}: {
  turn: AssistantTurn;
  onAnswer?: AnswerPermission;
}) {
  const end = turn.end;
  return (
    <div className="flex flex-col gap-2">
      {turn.blocks.map((block, i) => (
        <Block key={i} block={block} onAnswer={onAnswer} />
      ))}
      {end?.reason === "interrupted" && (
        <p className="text-xs text-muted-foreground">
          <span aria-hidden>⏹</span> interrupted by user
        </p>
      )}
      {end?.reason === "error" && end.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {end.error}
        </p>
      )}
      {end && end.reason === "done" && (end.costUsd !== null || end.model) && (
        <p className="text-xs text-muted-foreground">
          {end.model}
          {end.costUsd !== null && ` · $${end.costUsd.toFixed(4)}`}
          {end.tokens.input !== null &&
            ` · ${(end.tokens.input ?? 0).toLocaleString()} in / ${(
              end.tokens.output ?? 0
            ).toLocaleString()} out`}
        </p>
      )}
    </div>
  );
}

export function MessageList({
  view,
  onAnswerPermission,
}: {
  view: TurnView;
  /** Absent in read-only views (transcript replay); cards then render inert. */
  onAnswerPermission?: AnswerPermission;
}) {
  const onAnswer = onAnswerPermission;
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label="Chat transcript"
      className="flex flex-col gap-4"
    >
      {view.turns.map((turn, i) =>
        turn.kind === "user" ? (
          <UserMessage key={i} turn={turn} />
        ) : (
          <AssistantMessage key={i} turn={turn} onAnswer={onAnswer} />
        ),
      )}
      {view.running && !view.started && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          starting…
        </p>
      )}
    </div>
  );
}
