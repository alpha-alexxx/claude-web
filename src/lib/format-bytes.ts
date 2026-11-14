/**
 * Byte formatting shared by server read models and client badges/meters.
 *
 * Client-safe on purpose: `integrations/disk.ts` is `server-only` (it touches
 * the filesystem), but its human-size formatting is pure. Keeping it here means
 * the system meter can render "1.2 GiB" without pulling a server module into
 * the client graph. `disk.ts` re-exports it, so existing importers did not move.
 */

/** MiB below 1 GiB, one-decimal GiB above. */
export function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}
