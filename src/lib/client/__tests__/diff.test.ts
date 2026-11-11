import { describe, expect, it } from "vitest";
import {
  diffLines,
  editPreview,
  foldDiff,
  MAX_DIFF_LINES,
  type DiffLine,
  type DiffRow,
} from "../diff";

/** Compact shape for assertions: "kind:text". */
const shape = (lines: DiffLine[]): string[] =>
  lines.map((l) => `${l.kind}:${l.text}`);

describe("diffLines", () => {
  it("marks an unchanged file as all context", () => {
    const lines = diffLines("a\nb\n", "a\nb\n");
    expect(shape(lines)).toEqual(["context:a", "context:b"]);
    expect(lines.map((l) => [l.oldLine, l.newLine])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("emits a removal and an addition around a changed line", () => {
    expect(shape(diffLines("a\nb\nc", "a\nB\nc"))).toEqual([
      "context:a",
      "remove:b",
      "add:B",
      "context:c",
    ]);
  });

  it("renders an insertion without touching the surrounding lines", () => {
    expect(shape(diffLines("a\nc", "a\nb\nc"))).toEqual([
      "context:a",
      "add:b",
      "context:c",
    ]);
  });

  it("treats a trailing newline as a terminator, not an extra line", () => {
    expect(shape(diffLines("a\n", "a"))).toEqual(["context:a"]);
  });

  it("returns an empty diff for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("numbers added lines from the new file and removed from the old", () => {
    const lines = diffLines("one\ntwo", "one\nTWO\nthree");
    const added = lines.filter((l) => l.kind === "add");
    const removed = lines.filter((l) => l.kind === "remove");
    expect(added.map((l) => [l.text, l.newLine])).toEqual([
      ["TWO", 2],
      ["three", 3],
    ]);
    expect(removed.map((l) => [l.text, l.oldLine])).toEqual([["two", 2]]);
    // Additions never carry an old line number and vice versa.
    expect(added.every((l) => l.oldLine === null)).toBe(true);
    expect(removed.every((l) => l.newLine === null)).toBe(true);
  });

  it("degrades to a whole-file replace past the cap instead of freezing", () => {
    const oldText = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `o${i}`).join("\n");
    const newText = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `n${i}`).join("\n");
    const lines = diffLines(oldText, newText);
    expect(lines).toHaveLength(2 * (MAX_DIFF_LINES + 1));
    expect(lines[0]).toMatchObject({ kind: "remove", text: "o0" });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "add", text: `n${MAX_DIFF_LINES}` });
  });
});

describe("foldDiff", () => {
  const ctx = (n: number): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "context" as const,
      text: `c${i}`,
      oldLine: i + 1,
      newLine: i + 1,
    }));
  const rowsToShape = (rows: DiffRow[]): string[] =>
    rows.map((r) =>
      r.type === "fold"
        ? `fold:${r.count}`
        : `line:${r.line.kind}:${r.line.text}`,
    );

  it("leaves a short diff unfolded", () => {
    const lines = diffLines("a\nb\nc", "a\nB\nc");
    expect(rowsToShape(foldDiff(lines))).toEqual([
      "line:context:a",
      "line:remove:b",
      "line:add:B",
      "line:context:c",
    ]);
  });

  it("folds a long unchanged run into one row, keeping context around the change", () => {
    const lines: DiffLine[] = [
      ...ctx(20),
      { kind: "add", text: "new", oldLine: null, newLine: 21 },
      ...ctx(20).map((l) => ({ ...l, text: `${l.text}'` })),
    ];
    const rows = rowsToShape(foldDiff(lines, 2));
    // 2 context, add, 2 context, then the rest folded at the tail.
    expect(rows).toEqual([
      "fold:18",
      "line:context:c18",
      "line:context:c19",
      "line:add:new",
      "line:context:c0'",
      "line:context:c1'",
      "fold:18",
    ]);
  });

  it("folds a run with no changes at all into a single row", () => {
    expect(rowsToShape(foldDiff(ctx(10)))).toEqual(["fold:10"]);
  });

  it("never hides a changed line", () => {
    const lines = diffLines("a\nb\nc\nd", "a\nB\nc\nd");
    const shown = foldDiff(lines, 0).flatMap((r) =>
      r.type === "line" && r.line.kind !== "context" ? [r.line.text] : [],
    );
    expect(shown).toEqual(["b", "B"]);
  });
});

describe("editPreview", () => {
  it("previews an Edit as old/new strings", () => {
    const preview = editPreview("Edit", {
      file_path: "/w/a.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    expect(preview?.filePath).toBe("/w/a.ts");
    expect(shape(preview?.lines ?? [])).toEqual(["remove:const x = 1;", "add:const x = 2;"]);
  });

  it("previews a Write as all additions", () => {
    const preview = editPreview("Write", {
      file_path: "/w/new.ts",
      content: "line one\nline two",
    });
    expect(shape(preview?.lines ?? [])).toEqual(["add:line one", "add:line two"]);
  });

  it("concatenates MultiEdit hunks in order", () => {
    const preview = editPreview("MultiEdit", {
      file_path: "/w/a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    });
    expect(shape(preview?.lines ?? [])).toEqual(["remove:a", "add:A", "remove:b", "add:B"]);
  });

  it("returns null for a tool it cannot preview", () => {
    expect(editPreview("Bash", { command: "ls" })).toBeNull();
  });

  it("returns null when the edit fields are missing or mistyped", () => {
    expect(editPreview("Edit", { file_path: "/w/a.ts", old_string: "x" })).toBeNull();
    expect(editPreview("Write", { file_path: "/w/a.ts", content: 42 })).toBeNull();
    expect(editPreview("MultiEdit", { file_path: "/w/a.ts", edits: [] })).toBeNull();
  });

  it("requires a path", () => {
    expect(editPreview("Edit", { old_string: "a", new_string: "b" })).toBeNull();
  });
});
