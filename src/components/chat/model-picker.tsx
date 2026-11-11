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
 * Model picker. Pure presentational: renders the models the bootstrap gave
 * and reports the choice upward. It never calls the model route itself —
 * mid-session application is ChatColumn's job (POST /api/chat/[id]/model,
 * best-effort; the next turn's POST carries the model regardless).
 */

export interface ModelPickerProps {
  models: Array<{ id: string; label: string | null }>;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: ModelPickerProps) {
  const current =
    models.find((m) => m.id === value) ??
    models.find((m) => m.id === "auto");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} aria-label="Model">
          {current?.label ?? current?.id ?? value}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {models.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onClick={() => onChange(m.id)}
            className={cn(value === m.id && "bg-accent")}
          >
            {m.label ?? m.id}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
