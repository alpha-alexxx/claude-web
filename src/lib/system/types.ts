/**
 * Wire shapes for the sidebar's live system meters.
 *
 * Client-safe (no `server-only`): the meter component and its store import
 * these, while the sampling lives in `./stats`. Bytes, never pre-formatted
 * labels — the client already has `formatMiB`, and a percentage computed here
 * would freeze at the server's formatting choices.
 */

export interface SystemStats {
  /** ISO timestamp of the sample, for the "updated" affordance. */
  sampledAt: string;
  cpu: {
    /** Aggregate busy share across all cores over the sample interval (0..100). */
    busyPct: number;
    /** 1-minute load average — secondary context, not the bar's value. */
    load1: number;
    cores: number;
  };
  heap: {
    usedBytes: number;
    /** V8's heap ceiling (`--max-old-space-size`), not the machine's RAM. */
    limitBytes: number;
  };
  rss: {
    usedBytes: number;
    /** Machine RAM (`os.totalmem()`). */
    totalBytes: number;
  };
  /** Null when the data directory's filesystem cannot be measured. */
  disk: { freeBytes: number; totalBytes: number } | null;
}
