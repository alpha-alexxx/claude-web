"use client";

import { useMemo } from "react";
import { foldDiff, type DiffLine } from "@/lib/client/diff";
import { cn } from "@/lib/utils";

/**
 * DiffView — a unified diff, read as a terminal transcript rather than a
 * side-by-side compare. Two number gutters (old | new) because an approval
 * decision needs to know where a change lands in the file, and the sign is
 * what the eye actually scans.
 *
 * Long unchanged runs are folded to a single "N unchanged lines" row so a
 * one-line edit in a large file stays visible at a glance.
 */

const CONTEXT_LINES = 3;

function gutter(n: number | null): string {
  return n === null ? "" : String(n);
}

function DiffRowView({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn(
        "flex",
        line.kind === "add" && "bg-success/10",
        line.kind === "remove" && "bg-destructive/10",
      )}
    >
      <span className="w-9 shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground/50">
        {gutter(line.oldLine)}
      </span>
      <span className="w-9 shrink-0 select-none border-r border-border/40 pr-1.5 text-right tabular-nums text-muted-foreground/50">
        {gutter(line.newLine)}
      </span>
      <span
        className={cn(
          "w-5 shrink-0 select-none text-center",
          line.kind === "add" && "text-success",
          line.kind === "remove" && "text-destructive",
        )}
      >
        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
      </span>
      <span className="whitespace-pre pr-3 text-foreground/90">{line.text}</span>
    </div>
  );
}

export function DiffView({
  lines,
  className,
}: {
  lines: DiffLine[];
  className?: string;
}) {
  const rows = useMemo(() => foldDiff(lines, CONTEXT_LINES), [lines]);

  if (lines.length === 0) {
    return (
      <p className={cn("px-3 py-2 text-xs text-muted-foreground", className)}>
        No line changes.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "max-h-96 overflow-auto rounded-md bg-code-bg py-1.5 font-mono text-xs leading-5 text-code-text",
        className,
      )}
      role="group"
      aria-label="File changes"
    >
      <div className="min-w-max">
        {rows.map((row, i) =>
          row.type === "fold" ? (
            <div
              key={`f${i}`}
              className="my-1 flex items-center gap-2 px-3 py-0.5 text-[10px] text-muted-foreground"
            >
              <span className="h-px flex-1 bg-border/60" aria-hidden />
              {row.count} unchanged {row.count === 1 ? "line" : "lines"}
              <span className="h-px flex-1 bg-border/60" aria-hidden />
            </div>
          ) : (
            <DiffRowView key={`l${i}`} line={row.line} />
          ),
        )}
      </div>
    </div>
  );
}
