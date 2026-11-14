"use client"

import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

/**
 * A determinate meter bar.
 *
 * Radix supplies `role="progressbar"` and `aria-valuenow`/`aria-valuemin`/
 * `aria-valuemax` from `value` (0..100, clamped). The caller owns the meaning
 * of the value and passes `aria-valuetext` when a bare percentage would lose
 * information ("37% — Heap 183 of 500 MiB").
 *
 * `indicatorClassName` styles the fill separately from the track: in a meter
 * the fill carries the severity accent while the track stays a muted step, so
 * they cannot be expressed by one className.
 */
function Progress({
  className,
  indicatorClassName,
  value = 0,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indicatorClassName?: string
}) {
  // Radix clamps for display; clamp here too so the fill cannot overflow a
  // rounded track when a sample reports 100.4%.
  const pct = Math.min(100, Math.max(0, value ?? 0))

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={pct}
      className={cn(
        "relative h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          "h-full w-full flex-1 rounded-full bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none",
          indicatorClassName
        )}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
