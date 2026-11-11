import "server-only";
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

/**
 * Workspace containment — every cwd that reaches a provider session must
 * resolve (realpath, symlink-aware) inside ALLOWED_WORKSPACE_ROOTS.
 *
 * This module is the single chokepoint for cwd validation because the plan
 * treats "agent runs wherever the client says" as a traversal vulnerability
 * (a pointed-at ~/.ssh or /etc chat is a compromised host).
 *
 * Fail-closed: nonexistent paths and roots are rejected, not created; a
 * missing-root escape is impossible because only resolvable roots count.
 * Returns null on any escape — the route renders the 400; this never throws.
 */

/** Resolve one root, skipping those that do not exist. */
function realRoots(roots: string[]): string[] {
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(realpathSync(r));
    } catch {
      // a nonexistent root grants nothing
    }
  }
  return out;
}

/**
 * Resolve a client-sent cwd to a contained realpath, or null when it
 * escapes the roots (including via symlink) or does not exist.
 */
export function resolveWorkspacePath(roots: string[], candidate: string): string | null {
  if (!isAbsolute(candidate)) return null; // clients send absolute paths
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return null; // nonexistent cwd — reject, never create
  }
  for (const root of realRoots(roots)) {
    if (real === root || real.startsWith(root + sep)) return real;
  }
  return null;
}

/** Convenience predicate form. */
export function isWithinRoots(roots: string[], candidate: string): boolean {
  return resolveWorkspacePath(roots, candidate) !== null;
}
