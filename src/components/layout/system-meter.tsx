"use client";

import { useSyncExternalStore } from "react";
import { systemStatsStore } from "@/lib/client/system-stats-store";
import { Progress } from "@/components/ui/progress";
import { formatMiB } from "@/lib/format-bytes";

/**
 * The live host meters in the sidebar footer: CPU, process heap, RSS and the
 * data volume.
 *
 * Four single ratios against their own limits, so each is a metre (a bar), not
 * a chart: the job is "how full is this, right now", and a number beside the
 * bar keeps state from being colour-alone.
 *
 * Visibility is decided by the server, not by a role prop: the store reads
 * `/api/system/stats`, that route is admin-only, and a 403 stops the poller and
 * sets `denied`. So a regular user renders nothing and costs one request per
 * page load. Nothing is shown before the first sample either — a skeleton here
 * would advertise a panel most viewers never get.
 *
 * Tone is a threshold on the ratio, not a second dataset: under 75% the fill is
 * the app accent, 75%+ warning, 90%+ destructive. The track stays muted.
 */

type Tone = "normal" | "warning" | "danger";

const TONE_FILL: Record<Tone, string> = {
  normal: "bg-primary",
  warning: "bg-warning",
  danger: "bg-destructive",
};

function toneFor(pct: number): Tone {
  if (pct >= 90) return "danger";
  if (pct >= 75) return "warning";
  return "normal";
}

function percentOf(used: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 1000) / 10));
}

function MeterRow({
  label,
  detail,
  pct,
  valueText,
  ariaValueText,
}: {
  label: string;
  /** Secondary fact beside the label (sizes or load), already formatted. */
  detail?: string;
  pct: number;
  /** The percentage shown on the right. */
  valueText: string;
  ariaValueText: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-1.5 text-[11px] leading-tight">
        <span className="min-w-0 truncate text-muted-foreground">
          <span className="font-medium text-foreground/80">{label}</span>
          {detail ? ` · ${detail}` : ""}
        </span>
        <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
          {valueText}
        </span>
      </div>
      <Progress
        value={pct}
        className="h-1"
        indicatorClassName={TONE_FILL[toneFor(pct)]}
        aria-label={label}
        aria-valuetext={ariaValueText}
      />
    </div>
  );
}

export function SystemMeter() {
  const { stats, denied, failed } = useSyncExternalStore(
    systemStatsStore.subscribe,
    systemStatsStore.getSnapshot,
    systemStatsStore.getServerSnapshot,
  );

  // `stats === null` covers both "not sampled yet" and "not allowed"; `denied`
  // is the settled version of the latter and must stay silent for good.
  if (!stats || denied) return null;

  const heapPct = percentOf(stats.heap.usedBytes, stats.heap.limitBytes);
  const rssPct = percentOf(stats.rss.usedBytes, stats.rss.totalBytes);
  const diskUsed = stats.disk
    ? Math.max(0, stats.disk.totalBytes - stats.disk.freeBytes)
    : 0;
  const diskPct = stats.disk ? percentOf(diskUsed, stats.disk.totalBytes) : 0;

  return (
    <section
      aria-label="System usage"
      className="mb-2 space-y-2.5 border-b border-sidebar-border pb-2.5"
    >
      <div className="flex items-baseline gap-2">
        <h2 className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          System
        </h2>
        {failed && (
          <span
            className="text-[10px] text-warning"
            title="The last sample could not be read; showing the previous one."
          >
            stale
          </span>
        )}
      </div>

      <MeterRow
        label="CPU"
        detail={`load ${stats.cpu.load1.toFixed(2)}`}
        pct={Math.min(100, stats.cpu.busyPct)}
        valueText={`${Math.round(stats.cpu.busyPct)}%`}
        ariaValueText={`${Math.round(stats.cpu.busyPct)}% busy, load average ${stats.cpu.load1.toFixed(2)} across ${stats.cpu.cores} cores`}
      />
      <MeterRow
        label="Heap"
        detail={`${formatMiB(stats.heap.usedBytes)} of ${formatMiB(stats.heap.limitBytes)}`}
        pct={heapPct}
        valueText={`${Math.round(heapPct)}%`}
        ariaValueText={`${Math.round(heapPct)}% — Heap ${formatMiB(stats.heap.usedBytes)} of ${formatMiB(stats.heap.limitBytes)}`}
      />
      <MeterRow
        label="RAM"
        detail={`${formatMiB(stats.rss.usedBytes)} of ${formatMiB(stats.rss.totalBytes)}`}
        pct={rssPct}
        valueText={`${Math.round(rssPct)}%`}
        ariaValueText={`${Math.round(rssPct)}% — process RSS ${formatMiB(stats.rss.usedBytes)} of ${formatMiB(stats.rss.totalBytes)}`}
      />
      {stats.disk ? (
        <MeterRow
          label="Storage"
          detail={`${formatMiB(stats.disk.freeBytes)} free`}
          pct={diskPct}
          valueText={`${Math.round(diskPct)}%`}
          ariaValueText={`${Math.round(diskPct)}% — ${formatMiB(stats.disk.freeBytes)} free of ${formatMiB(stats.disk.totalBytes)}`}
        />
      ) : (
        <p className="text-[11px] leading-tight text-muted-foreground">
          Storage · not measurable
        </p>
      )}
    </section>
  );
}
