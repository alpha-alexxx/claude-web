import { describe, expect, it } from "vitest";
import { extensionFor, FILE_NAME, sniffImageType } from "../mime";

/**
 * Type detection is the security boundary of the render endpoint: the bytes
 * that will be streamed are the bytes that were sniffed, and nothing else.
 */

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "latin1"));
}

describe("sniffImageType", () => {
  it("recognises the six served formats by magic bytes", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      "image/png",
    );
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe("image/jpeg");
    expect(sniffImageType(ascii("GIF89a...."))).toBe("image/gif");
    expect(sniffImageType(ascii("GIF87a...."))).toBe("image/gif");
    expect(sniffImageType(ascii("RIFF\x24\x00\x00\x00WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(ascii("\x00\x00\x00\x1cftypavif\x00\x00"))).toBe("image/avif");
    expect(sniffImageType(bytes(0x00, 0x00, 0x01, 0x00, 0x01, 0x00))).toBe("image/x-icon");
  });

  it("refuses HTML, SVG and text however they are dressed up", () => {
    // The whole point: an agent can write any of these, and an inline HTML or
    // SVG document would execute script in this app's origin.
    expect(sniffImageType(ascii("<!doctype html><script>al"))).toBeNull();
    expect(sniffImageType(ascii("<svg xmlns=\"http://ww"))).toBeNull();
    expect(sniffImageType(ascii("  <html><body>"))).toBeNull();
    expect(sniffImageType(ascii("<?xml version=\"1.0\"?>"))).toBeNull();
    expect(sniffImageType(ascii("# just some text\n"))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });

  it("refuses a truncated header rather than guessing", () => {
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull();
    expect(sniffImageType(ascii("RIF"))).toBeNull();
  });
});

describe("extensionFor", () => {
  it("maps every served type to a filename extension", () => {
    expect(extensionFor("image/png")).toBe("png");
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("image/gif")).toBe("gif");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("image/avif")).toBe("avif");
    expect(extensionFor("image/x-icon")).toBe("ico");
  });

  it("has no extension for anything it will not serve", () => {
    expect(extensionFor("text/html")).toBeNull();
    expect(extensionFor("image/svg+xml")).toBeNull();
  });

  it("builds a Content-Disposition that cannot break out of the filename", () => {
    expect(FILE_NAME("image/png")).toBe("image.png");
    // A type that reached here would be a bug, but the fallback must still be
    // an inert filename rather than something quoting-sensitive.
    expect(FILE_NAME("text/html")).toBe("download.bin");
  });
});
