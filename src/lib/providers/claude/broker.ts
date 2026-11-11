import "server-only";
import { PermissionBroker } from "./permissions";

/**
 * Per-process permission broker singleton.
 *
 * It lives above the routes because two different handlers meet here: the
 * chat route registers pending requests, and `POST /api/permissions/…`
 * answers them. A broker per route folder would mean the answer route could
 * never see the chat route's requests.
 *
 * Memory-only by design: an in-flight prompt cannot survive a restart (the
 * CLI process dies with the server), and the allow-for-session list is
 * explicitly not persisted.
 */

/** The SDK's own tool gate waits 5 min; stay under it so we deny first. */
const PERMISSION_TIMEOUT_MS = 4 * 60_000;

let broker: PermissionBroker | null = null;

export function getPermissionBroker(): PermissionBroker {
  if (!broker) broker = new PermissionBroker({ timeoutMs: PERMISSION_TIMEOUT_MS });
  return broker;
}

/** Test seam: drop the singleton so the next call builds a fresh broker. */
export function resetPermissionBrokerForTest(): void {
  broker = null;
}
