"use client";

import { useState } from "react";
import {
  type AssistantBlock,
  type AssistantTurn,
  type PermissionCardView,
  type ToolCallView,
  type TurnView,
  type UserTurn,
} from "@/lib/client/chat-view";
import { cn } from "@/lib/utils";

/**
 * Transcript renderer: walks a TurnView and renders each turn. Pure mapping
 * from the view-model to JSX — no stream logic, no state beyond local
 * collapse toggles. aria-live receives appended text as it streams.
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
        <span className="font-mono">💭</span>
        Thinking
        <span className="ml-auto">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
      )}
    </div>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        aria-expanded={open}
      >
        {open ? "hide" : "show"} {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-code-bg p-2 font-mono text-xs text-code-text">
          {safeJson(value)}
        </pre>
      )}
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const STATUS_ICON: Record<ToolCallView["status"], string> = {
  running: "⏳",
  ok: "✓",
  error: "✕",
};
const STATUS_CLASS: Record<ToolCallView["status"], string> = {
  running: "text-muted-foreground animate-pulse",
  ok: "text-foreground",
  error: "text-destructive",
};

function ToolBlock({ tool }: { tool: ToolCallView }) {
  return (
    <div
      className={cn(
        "rounded-lg border",
        tool.status === "error"
          ? "border-destructive/40"
          : "border-border",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className={cn("font-mono", STATUS_CLASS[tool.status])}>
          {STATUS_ICON[tool.status]}
        </span>
        <span className="font-medium">{tool.name}</span>
        <span className="truncate text-muted-foreground">{tool.summary}</span>
        {tool.parentToolUseId && (
          <span
            className="ml-auto shrink-0 rounded bg-clay-tint px-1.5 py-0.5 text-[10px] text-foreground/70"
            title="Subagent tool call (parent shown above)"
          >
            subagent
          </span>
        )}
      </div>
      <div className="space-y-1 border-t border-border/60 px-3 py-2">
        <JsonDetails label="input" value={tool.input} />
        {tool.output !== null && (
          <pre className="max-h-64 overflow-auto rounded bg-code-bg p-2 font-mono text-xs text-code-text">
            {tool.output}
          </pre>
        )}
      </div>
    </div>
  );
}

function PermissionBlock({ card }: { card: PermissionCardView }) {
  return (
    <div className="rounded-lg border border-warning/50 bg-clay-tint/50">
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <span className="font-mono">🔑</span>
        <span className="font-medium">{card.toolName}</span>
        <span className="text-muted-foreground">
          wants to run — awaiting your answer
        </span>
      </div>
      {card.displayHint && (
        <div className="border-t border-warning/30 px-3 py-2 font-mono text-xs text-foreground/80">
          {card.displayHint}
        </div>
      )}
      <div className="border-t border-warning/30 px-3 py-2">
        <JsonDetails label="input" value={card.input} />
      </div>
    </div>
  );
}

function Block({ block }: { block: AssistantBlock }) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap break-words text-sm">{block.text}</p>;
    case "thinking":
      return <ThinkingBlock text={block.text} />;
    case "tool":
      return <ToolBlock tool={block.tool} />;
    case "permission":
      return <PermissionBlock card={block.card} />;
  }
}

function AssistantMessage({ turn }: { turn: AssistantTurn }) {
  const end = turn.end;
  return (
    <div className="flex flex-col gap-2">
      {turn.blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {end?.reason === "interrupted" && (
        <p className="text-xs text-muted-foreground">⏹ interrupted by user</p>
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

export function MessageList({ view }: { view: TurnView }) {
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
          <AssistantMessage key={i} turn={turn} />
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
