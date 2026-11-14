/**
 * Parses the tunnel hostnames the dev server should trust for `/_next` and
 * `/_nextjs` requests (`next.config.ts` → `allowedDevOrigins`).
 *
 * Kept out of `next.config.ts` so it can be tested: Next loads that file
 * through its own loader, where a test cannot reach it, and a malformed entry
 * there fails silently as a `403 Unauthorized` on a hashed asset URL.
 *
 * Rules mirroring the matcher (Next docs, `allowedDevOrigins`): entries are
 * BARE hostnames — no scheme, no port, no path — because only the request's
 * hostname is compared. `*` stands for exactly one label, `**` for one or more.
 * A scheme or port in an entry therefore never matches anything, so it is
 * stripped here rather than left to fail mysteriously.
 */
const QUICK_TUNNEL_WILDCARD = "**.trycloudflare.com";

export function parseAllowedDevOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .map(stripSchemeAndPort)
    .filter(Boolean);
  return [...new Set([...entries, QUICK_TUNNEL_WILDCARD])];
}

function stripSchemeAndPort(entry: string): string {
  if (!entry) return "";
  // URL parsing needs a scheme to treat the value as hierarchical, and rejects
  // wildcards — so a wildcard entry is taken as-is (minus any stray path).
  if (entry.includes("*")) return entry.split("/")[0] ?? "";
  try {
    return new URL(entry.includes("://") ? entry : `http://${entry}`).hostname;
  } catch {
    return "";
  }
}
