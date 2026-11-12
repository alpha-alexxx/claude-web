import "server-only";

/**
 * Image type detection for the render endpoint.
 *
 * Type is decided by MAGIC BYTES — never by the file extension and never by a
 * remote server's `content-type`. The bytes about to be streamed are the bytes
 * that were checked, so there is no gap between the decision and the body.
 *
 * SVG is deliberately absent from the served set: an SVG is an HTML document,
 * inert inside `<img>` but script-executing when the same URL is opened in a
 * tab, and this endpoint exists precisely to make agent-supplied paths
 * reachable by URL.
 */

export const SERVED_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/x-icon",
] as const;

export type ServedImageType = (typeof SERVED_TYPES)[number];

const EXTENSIONS: Record<ServedImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/x-icon": "ico",
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[at + i] !== prefix[i]) return false;
  }
  return true;
}

function startsWithAscii(bytes: Uint8Array, text: string, at = 0): boolean {
  return startsWith(bytes, Array.from(text, (c) => c.charCodeAt(0)), at);
}

/**
 * Sniff a type from the first bytes of a body. Returns null for anything not
 * in the served set — including a body too short to identify.
 */
export function sniffImageType(bytes: Uint8Array): ServedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a")) return "image/gif";
  // RIFF....WEBP — the four size bytes between the markers are not inspected.
  if (startsWithAscii(bytes, "RIFF") && startsWithAscii(bytes, "WEBP", 8)) return "image/webp";
  // ISO-BMFF: size(4) 'ftyp' brand(4). AVIF uses the avif/avis brands.
  if (
    startsWithAscii(bytes, "ftyp", 4) &&
    (startsWithAscii(bytes, "avif", 8) || startsWithAscii(bytes, "avis", 8))
  ) {
    return "image/avif";
  }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return null;
}

/** Filename extension for a served type, or null for anything else. */
export function extensionFor(mime: string): string | null {
  return mime in EXTENSIONS ? EXTENSIONS[mime as ServedImageType] : null;
}

/** The `Content-Disposition` filename. Derived from the type, never from input. */
export function FILE_NAME(mime: string): string {
  const ext = extensionFor(mime);
  return ext ? `image.${ext}` : "download.bin";
}

export function isServedType(mime: string): mime is ServedImageType {
  return mime in EXTENSIONS;
}
