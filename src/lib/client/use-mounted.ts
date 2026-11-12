"use client";

import { useSyncExternalStore } from "react";

/**
 * Hydration-safe "is the client mounted" flag.
 *
 * Returns false during the server render AND during the first client
 * (hydration) render, then true on the re-render after hydration. Components
 * use it to gate anything that must not be computed twice — a random id, the
 * persisted theme — without a setState-in-effect (which the react-hooks lint
 * rule rejects).
 */

const emptySubscribe = () => () => {};

export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
