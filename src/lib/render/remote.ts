import "server-only";
import { isIP } from "node:net";
import { sniffImageType, type ServedImageType } from "./mime";

/**
 * The remote branch of the render endpoint — and therefore its SSRF surface.
 *
 * A token is minted for a remote URL only after it passes this policy, and the
 * GET re-fetches it. Everything here is a refusal first: https only, no
 * private/loopback/link-local destination, no redirects (a 302 to
 * `http://127.0.0.1/` is the classic bounce), a byte cap enforced on both the
 * declared length and the stream itself, and a timeout.
 *
 * Name-based checks (`.localhost`, `.internal`, `.local`) are a cheap first
 * filter, not a DNS resolver. A hostname that resolves to a private address is
 * a real gap and is documented rather than papered over: resolving would mean
 * re-implementing the resolver, and the endpoint also demands a valid
 * same-origin POST from a signed-in user, which is what makes this an
 * agent-content problem rather than an anonymous SSRF oracle.
 */

export type RemoteFailureReason =
  | "invalid_url"
  | "insecure_scheme"
  | "destination_not_allowed"
  | "bad_status"
  | "too_large"
  | "unsupported_type"
  | "timeout"
  | "fetch_failed";

export class FetchRemoteError extends Error {
  constructor(readonly reason: RemoteFailureReason) {
    super(`remote image refused: ${reason}`);
    this.name = "FetchRemoteError";
  }
}

export interface RemoteImage {
  bytes: Uint8Array;
  mime: ServedImageType;
}

export interface FetchRemoteOptions {
  /** Injected so tests need no network; routes pass the global `fetch`. */
  fetchImpl: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Hostnames that are local by definition, regardless of what DNS says. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".localdomain"];

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null if malformed.
 *
 * Needed because the interesting addresses are the COMPRESSED forms: nobody
 * writes `0:0:0:0:0:ffff:7f00:1`, they write `::ffff:7f00:1`. Pattern-matching
 * the text of a literal is how a checker quietly misses the form an attacker
 * picks, so every check below runs on the expanded groups instead.
 */
function expandIpv6(host: string): number[] | null {
  if (!host.includes(":")) return null;

  // An embedded dotted-quad tail ("::ffff:127.0.0.1") is two groups.
  let text = host;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (tail) {
    const octets = tail[2].split(".").map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((piece) => (/^[0-9a-f]{1,4}$/i.test(piece) ? parseInt(piece, 16) : NaN));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const groups = [...left, ...right];
  if (groups.some((n) => Number.isNaN(n))) return null;
  if (halves.length === 2) {
    // "::" stands for at least one zero group; two is fine, none is not.
    const fill = 8 - groups.length;
    if (fill < 1) return null;
    return [...left, ...new Array<number>(fill).fill(0), ...right];
  }
  return groups.length === 8 ? groups : null;
}

/** True for any literal address that is not publicly routable. */
function isForbiddenHost(hostname: string): boolean {
  // A single trailing dot is the DNS root ("localhost." === "localhost"). Node's
  // URL parser strips it from IPv4 already but NOT from names, so without this
  // `https://localhost./` — and `metadata.google.internal.` — sails through.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

  const family = isIP(host);
  if (family === 4) {
    return isPrivateIpv4(host.split(".").map(Number));
  }
  if (family === 6) {
    const g = expandIpv6(host);
    if (!g) return true; // isIP said 6 but we cannot read it: refuse, don't guess.
    const [a, b, c] = g;

    // :: and ::1 — unspecified and loopback.
    if (g.every((n) => n === 0)) return true;
    if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;
    // fe80::/10 link-local, fc00::/7 unique-local, ff00::/8 multicast.
    if ((a & 0xffc0) === 0xfe80 || (a & 0xfe00) === 0xfc00 || (a & 0xff00) === 0xff00) return true;
    // 100::/64 discard-only.
    if (a === 0x0100 && b === 0 && c === 0 && g[3] === 0) return true;

    // Addresses that CARRY an IPv4 address: unwrap it and re-check, because
    // "[::ffff:7f00:1]" reaches 127.0.0.1 on a dual-stack host. This covers
    // ::ffff:0:0/96 (IPv4-mapped), ::/96 (IPv4-compatible), 64:ff9b::/96
    // (NAT64), 64:ff9b:1::/48 (local-use NAT64) and 2002::/16 (6to4).
    const embedded = embeddedIpv4(g);
    if (embedded) return isPrivateIpv4(embedded);
    return false;
  }

  // A name: refuse the ones that are local by definition. Dotted-but-not-IP
  // names like "127.0.0.1.nip.io" are covered by the suffix list below only
  // partially, which is the documented gap.
  if (host === "localhost") return true;
  return BLOCKED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/** The IPv4 address an IPv6 form embeds in its low bits, if it embeds one. */
function embeddedIpv4(g: number[]): number[] | null {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeroPrefix = (n: number) => g.slice(0, n).every((group) => group === 0);

  if (zeroPrefix(5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:0:0/96
  if (zeroPrefix(6)) return v4(g[6], g[7]); // ::/96, IPv4-compatible
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return v4(g[6], g[7]); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return v4(g[6], g[7]); // 64:ff9b:1::/48
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 2002::/16 6to4
  return null;
}

/**
 * The URL policy alone, split out so the POST can reject a URL before it mints
 * a token (the GET runs the same check again — a token is not a bypass).
 */
export function checkRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRemoteError("invalid_url");
  }
  if (url.protocol !== "https:") throw new FetchRemoteError("insecure_scheme");
  if (!url.hostname) throw new FetchRemoteError("invalid_url");
  if (url.username || url.password) throw new FetchRemoteError("invalid_url");
  if (isForbiddenHost(url.hostname)) throw new FetchRemoteError("destination_not_allowed");
  return url;
}

/** Read a response body up to `maxBytes`, refusing (not truncating) beyond it. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  onTimeout: () => Promise<never>,
) {
  if (!body) throw new FetchRemoteError("bad_status");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // The timeout has to be re-raced per chunk, not applied to the initial
      // request alone: a server that sends headers immediately and then drips
      // the body forever would otherwise hold the route for minutes. Whichever
      // settles first wins, and an abandoned read is cancelled below.
      const { done, value } = await Promise.race([reader.read(), onTimeout()]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new FetchRemoteError("too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    // An abandoned stream is a held socket; cancel is best-effort by design.
    void body.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Fetch a remote image, enforcing policy. Throws `FetchRemoteError`. */
export async function fetchRemoteImage(
  raw: string,
  options: FetchRemoteOptions,
): Promise<RemoteImage> {
  const url = checkRemoteUrl(raw);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // One deadline for the whole exchange (connect → headers → body). Rejects
  // when it fires; never resolves, so it can be raced against any await.
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new FetchRemoteError("timeout")),
      { once: true },
    );
  });
  // A pending race loser must not surface as an unhandled rejection.
  deadline.catch(() => {});

  try {
    let res: Response;
    try {
      res = await Promise.race([
        options.fetchImpl(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "image/*" },
        }),
        deadline,
      ]);
    } catch (err) {
      if (err instanceof FetchRemoteError) throw err;
      // Abort surfaces as a rejection too; the timer tells us which it was.
      throw new FetchRemoteError(timedOut ? "timeout" : "fetch_failed");
    }

    if (res.status !== 200) throw new FetchRemoteError("bad_status");

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      void res.body?.cancel().catch(() => {});
      throw new FetchRemoteError("too_large");
    }

    const bytes = await readCapped(res.body, maxBytes, () => deadline);
    const mime = sniffImageType(bytes);
    if (!mime) throw new FetchRemoteError("unsupported_type");
    return { bytes, mime };
  } finally {
    clearTimeout(timer);
  }
}
