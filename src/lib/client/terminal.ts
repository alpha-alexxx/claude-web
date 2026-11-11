/**
 * Terminal text normalization for tool output.
 *
 * Bash output arrives as raw bytes: escape sequences colour it, and carriage
 * returns overwrite lines (every progress bar, every `npm` spinner). Rendered
 * literally in a <pre>, that is unreadable noise. Both transformations are
 * pure and total — they never throw and never lose text that a terminal would
 * have shown.
 */

/**
 * CSI (`ESC [ … m`), OSC (`ESC ] … BEL|ST`), and two-character escapes.
 * Built from the ECMA-48 grammar rather than a colour-only pattern: tool
 * output contains cursor moves and window titles too, not just SGR.
 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Resolve carriage-return overwrites the way a terminal does: within one
 * line, each `\r` returns the cursor to column 0 and later text overwrites
 * what was there. Only the final visible state matters.
 *
 * A bare `\r\n` is a line ending, not an overwrite, so it is handled as a
 * line break first.
 */
export function resolveCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      // The cursor returns to 0 each time; trailing parts replace from there.
      let visible = parts[0];
      for (let i = 1; i < parts.length; i++) {
        visible = parts[i] + visible.slice(parts[i].length);
      }
      return visible;
    })
    .join("\n");
}

/** Everything a <pre> should receive for tool output. */
export function normalizeTerminal(text: string): string {
  return resolveCarriageReturns(stripAnsi(text));
}
