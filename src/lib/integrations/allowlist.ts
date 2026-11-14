import "server-only";
import type { AppEnv } from "@/lib/env";
import { INTEGRATIONS } from "./registry";

/**
 * The effective install allowlist — ONE rule, so the card and the route cannot
 * disagree about which specs the server will run.
 *
 * `INSTALL_ALLOWLIST` is presence-based:
 *
 *   - absent            → the registry's own pinned specs (installs work out of
 *                         the box; the registry pin is still the only spec that
 *                         is ever handed to npm)
 *   - present, non-empty → exactly that list — narrows what the page offers
 *   - present, empty    → `[]`, i.e. installs disabled
 *
 * The second gate is not weakened by the default: a spec still comes only from
 * the registry, and this function only ever answers subset-of-registry.
 */
export function defaultAllowlist(): string[] {
  return INTEGRATIONS.map((s) => s.installSpec).filter((s): s is string => Boolean(s));
}

export function installAllowlist(env: AppEnv): string[] {
  return env.INSTALL_ALLOWLIST.set ? env.INSTALL_ALLOWLIST.list : defaultAllowlist();
}
