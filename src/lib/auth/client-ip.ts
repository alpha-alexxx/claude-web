import "server-only";
import { getEnv } from "@/lib/env";

/**
 * The caller's IP for the audit log.
 *
 * X-Forwarded-For is only read when TRUST_PROXY is on: exposed directly, a
 * client can set that header to anything, and an audit row with a forged IP is
 * worse than one with a proxy's. When the header is trusted the LAST entry is
 * used — the one the proxy appended — not the first, which the client controls.
 */
export function clientIp(req: Request): string | null {
  if (getEnv().TRUST_PROXY) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const last = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .at(-1);
      if (last) return last.slice(0, 64);
    }
  }
  const real = req.headers.get("x-real-ip");
  if (getEnv().TRUST_PROXY && real) return real.trim().slice(0, 64) || null;
  return null;
}
