"use client";

import { useState } from "react";

/**
 * Disclosure for raw JSON. Collapsed by default and never the primary view:
 * when a tool has a better rendering (a diff, terminal output, a question)
 * this is the fallback for the fields that rendering cannot show.
 */
export function JsonDetails({
  label,
  value,
  className,
}: {
  label: string;
  value: unknown;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        aria-expanded={open}
      >
        {open ? "Hide" : "Show"} {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-code-bg p-2 font-mono text-xs text-code-text">
          {safeJson(value)}
        </pre>
      )}
    </div>
  );
}

/** JSON.stringify that cannot throw on cycles or BigInt. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
