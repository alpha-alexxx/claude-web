import { describe, expect, it } from "vitest";
import {
  normalizeTerminal,
  resolveCarriageReturns,
  stripAnsi,
} from "../terminal";

describe("stripAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m: bad")).toBe("error: bad");
  });

  it("removes cursor movement and erase sequences", () => {
    expect(stripAnsi("a\u001b[2K\u001b[1Gb")).toBe("ab");
  });

  it("removes OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
    expect(stripAnsi("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
  });

  it("leaves plain text and existing newlines alone", () => {
    expect(stripAnsi("line one\nline two")).toBe("line one\nline two");
  });
});

describe("resolveCarriageReturns", () => {
  it("keeps only the final state of an overwritten progress line", () => {
    expect(resolveCarriageReturns("downloading 10%\rdownloading 50%\rdownloading 100%")).toBe(
      "downloading 100%",
    );
  });

  it("keeps the tail of a longer earlier line that the overwrite does not cover", () => {
    expect(resolveCarriageReturns("abcdef\rXY")).toBe("XYcdef");
  });

  it("treats CRLF as a line ending, not an overwrite", () => {
    expect(resolveCarriageReturns("one\r\ntwo")).toBe("one\ntwo");
  });

  it("resolves each line independently", () => {
    expect(resolveCarriageReturns("a\rb\nc\rd")).toBe("b\nd");
  });
});

describe("normalizeTerminal", () => {
  it("composes both passes", () => {
    expect(normalizeTerminal("\u001b[32mok\u001b[0m 10%\r\u001b[32mok\u001b[0m 99%")).toBe(
      "ok 99%",
    );
  });

  it("is total: ordinary output passes through unchanged", () => {
    const text = "src/app/page.tsx\n  12:4  error  no-unused-vars\n";
    expect(normalizeTerminal(text)).toBe(text);
  });
});
