"use client";

import { KeyRoundIcon, LockKeyholeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  PermissionCardView,
  PermissionDecision,
} from "@/lib/client/chat-view";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { JsonDetails } from "./json-details";

/**
 * PermissionCard — the one place a turn stops and waits for a person.
 *
 * Everything else in the transcript is a record; this is a gate. So it is the
 * only card that is tinted before it is answered, the only one with buttons,
 * and the only one whose answered state is written in past tense ("Allowed")
 * — after the click it is history, not an action.
 *
 * Deny is deliberately not the visual default despite being the safe answer:
 * the CLI's own prompt leads with allow, and an operator clicking through a
 * long turn should not have the destructive button where their hand lands.
 */

const ANSWER_LABEL: Record<PermissionDecision, string> = {
  allow: "Allowed",
  allow_session: "Allowed for this session",
  deny: "Denied",
};

export function PermissionCard({
  card,
  onAnswer,
}: {
  card: PermissionCardView;
  /** Absent in read-only views (transcript replay); the card renders inert. */
  onAnswer?: (requestId: string, decision: PermissionDecision) => void;
}) {
  const answered = card.status === "answered";
  const ask =
    card.toolName === "AskUserQuestion" ? "is asking you a question" : "wants to run";

  return (
    <div
      role="group"
      aria-label={answered ? "Permission request answered" : "Permission request"}
      className={cn(
        "rounded-lg border",
        answered ? "border-border bg-muted/30" : "border-warning/50 bg-clay-tint/50",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <HugeiconsIcon
          icon={answered ? LockKeyholeIcon : KeyRoundIcon}
          className={cn(
            "size-3.5 shrink-0",
            answered ? "text-muted-foreground" : "text-warning",
          )}
          aria-hidden
        />
        <span className="shrink-0 font-medium">{card.toolName}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {answered
            ? (card.answer ? ANSWER_LABEL[card.answer] : "answered")
            : `${ask} — awaiting your answer`}
        </span>
      </div>

      {card.displayHint && (
        <div className="border-t border-border/40 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground/80">
          {card.displayHint}
        </div>
      )}

      <div className="border-t border-border/40 px-3 py-2">
        <JsonDetails label="input" value={card.input} />
      </div>

      {!answered && onAnswer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-3 py-2">
          <Button
            type="button"
            size="xs"
            onClick={() => onAnswer(card.requestId, "allow")}
          >
            Allow
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onAnswer(card.requestId, "allow_session")}
          >
            Allow for session
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            onClick={() => onAnswer(card.requestId, "deny")}
          >
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}
