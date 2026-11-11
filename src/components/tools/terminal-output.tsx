"use client";

import { useMemo } from "react";
import { normalizeTerminal } from "@/lib/client/terminal";
import { cn } from "@/lib/utils";

/**
 * TerminalOutput — command output, rendered as a terminal would have shown
 * it: ANSI escapes stripped, carriage-return overwrites resolved, wrapped in
 * a scroll box with both axes so long lines and wide tables stay readable.
 *
 * Deliberately monochrome. The agent's colour codes carry no meaning we can
 * trust (and after stripping there is none left); what matters here is
 * alignment of columns, which the mono face and `whitespace-pre` preserve.
 */

export function TerminalOutput({
  text,
  truncated,
  className,
  label = "Output",
}: {
  text: string;
  /** True when the mapper capped the output — stated, never silently hidden. */
  truncated?: boolean;
  className?: string;
  label?: string;
}) {
  const clean = useMemo(() => normalizeTerminal(text), [text]);
  const lines = useMemo(() => (clean === "" ? 0 : clean.split("\n").length), [clean]);

  return (
    <div className={cn("overflow-hidden rounded-md bg-code-bg", className)}>
      <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1 text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {lines.toLocaleString()} {lines === 1 ? "line" : "lines"}
          {truncated && " · truncated"}
        </span>
      </div>
      <pre className="max-h-72 overflow-auto p-2.5 font-mono text-xs leading-5 whitespace-pre text-code-text">
        {clean}
      </pre>
    </div>
  );
}
