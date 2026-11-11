"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Cwd picker: chooses the conversation's working directory from the
 * ALLOWED_WORKSPACE_ROOTS the bootstrap returned. Free-text entry is
 * deliberately absent — the server fail-closes any path outside the
 * roots, so a picker offering only valid choices is honest UI.
 *
 * Subdirectories of a root are addressable via the composer (CLI tools can
 * `cd`), but each turn starts in the chosen root; Phase 5's conversation
 * list may refine this into a full tree picker.
 */

export interface CwdPickerProps {
  roots: string[];
  value: string;
  onChange: (cwd: string) => void;
  disabled?: boolean;
}

export function CwdPicker({ roots, value, onChange, disabled }: CwdPickerProps) {
  if (roots.length === 0) {
    return (
      <Button variant="ghost" size="sm" disabled aria-label="Working directory">
        no workspace roots
      </Button>
    );
  }
  // Abbreviate the common prefix so long roots stay readable. There is no
  // HOME in the browser — show the full path when no shortening applies.
  const short = (p: string): string => (p.length > 34 ? "…" + p.slice(-32) : p);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || roots.length === 0}
          aria-label="Working directory"
          className="max-w-72 font-mono text-xs"
        >
          <span className="truncate">{short(value || roots[0])}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Working directory</DropdownMenuLabel>
        {roots.map((r) => (
          <DropdownMenuItem
            key={r}
            onClick={() => onChange(r)}
            className={cn(value === r && "bg-accent")}
          >
            <span className="max-w-96 truncate font-mono text-xs">{short(r)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
