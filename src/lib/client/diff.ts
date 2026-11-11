/**
 * Line diff for tool previews — the Edit/Write cards must show what will
 * change BEFORE the user approves them, so this has to run in the browser on
 * inputs that arrive as plain strings.
 *
 * Implementation: classic LCS over lines (O(n·m) time and memory). Tool edits
 * are human-sized (a few hundred lines); the cap below refuses the
 * pathological case rather than freezing the tab on a generated lockfile.
 * When the cap trips we degrade to a whole-file replace, which is still
 * truthful (every old line out, every new line in) — never a silent empty
 * diff.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old text, null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the new text, null for removed lines. */
  newLine: number | null;
}

/** Refuse quadratic work above this many lines on either side. */
export const MAX_DIFF_LINES = 2000;

function split(text: string): string[] {
  // A trailing newline is a terminator, not an extra empty line.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function wholeFile(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  split(oldText).forEach((text, i) =>
    out.push({ kind: "remove", text, oldLine: i + 1, newLine: null }),
  );
  split(newText).forEach((text, i) =>
    out.push({ kind: "add", text, oldLine: null, newLine: i + 1 }),
  );
  return out;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = split(oldText);
  const b = split(newText);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return wholeFile(oldText, newText);
  }

  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i], oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "remove", text: a[i], oldLine: i + 1, newLine: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j], oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) {
    out.push({ kind: "remove", text: a[i], oldLine: i + 1, newLine: null });
  }
  for (; j < b.length; j++) {
    out.push({ kind: "add", text: b[j], oldLine: null, newLine: j + 1 });
  }
  return out;
}

export interface EditPreview {
  filePath: string;
  lines: DiffLine[];
}

/** One rendered row: either a real line or a "N lines hidden" fold. */
export type DiffRow =
  | { type: "line"; line: DiffLine }
  | { type: "fold"; count: number };

/**
 * Collapse long runs of unchanged lines, keeping `context` lines either side
 * of every change. A 400-line Edit to one line would otherwise bury the change
 * — the fold is what makes an approval card readable at a glance.
 *
 * Folds only ever hide `context`-kind lines, so nothing the user must judge is
 * ever hidden.
 */
export function foldDiff(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (line.kind === "context") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
      keep.add(j);
    }
  });

  const rows: DiffRow[] = [];
  let hidden = 0;
  lines.forEach((line, i) => {
    if (keep.has(i)) {
      if (hidden > 0) {
        rows.push({ type: "fold", count: hidden });
        hidden = 0;
      }
      rows.push({ type: "line", line });
    } else {
      hidden++;
    }
  });
  if (hidden > 0) rows.push({ type: "fold", count: hidden });
  return rows;
}

/**
 * Recognize the tool inputs this app can preview as a diff: Edit and
 * MultiEdit carry old/new strings, Write carries the whole new content.
 * Anything else returns null and the caller falls back to raw JSON.
 */
export function editPreview(
  toolName: string,
  input: Record<string, unknown>,
): EditPreview | null {
  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null;
  if (!path) return null;

  if (toolName === "Write" && typeof input.content === "string") {
    return { filePath: path, lines: diffLines("", input.content) };
  }

  if (toolName === "Edit") {
    const oldText = typeof input.old_string === "string" ? input.old_string : null;
    const newText = typeof input.new_string === "string" ? input.new_string : null;
    if (oldText !== null && newText !== null) {
      return { filePath: path, lines: diffLines(oldText, newText) };
    }
  }

  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const lines: DiffLine[] = [];
    for (const raw of input.edits) {
      if (!raw || typeof raw !== "object") continue;
      const edit = raw as Record<string, unknown>;
      const oldText = typeof edit.old_string === "string" ? edit.old_string : null;
      const newText = typeof edit.new_string === "string" ? edit.new_string : null;
      if (oldText === null || newText === null) continue;
      lines.push(...diffLines(oldText, newText));
    }
    return lines.length > 0 ? { filePath: path, lines } : null;
  }

  return null;
}
