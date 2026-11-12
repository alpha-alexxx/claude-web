import { describe, it, expect } from "vitest";
import {
  assistantMessageContent,
  deriveTitle,
  TITLE_MAX,
  userMessageContent,
  viewFromMessages,
} from "../transcript";

/**
 * Transcript replay is a deserialize, so its failure modes are all about
 * trusting what is on disk: a row written by an older build, a truncated
 * JSON blob, a hand-edited DB. Replay must never throw and must never render
 * a permission card as answerable — the turn it belonged to is long over.
 */

describe("deriveTitle", () => {
  it("flattens whitespace and trims", () => {
    expect(deriveTitle("  fix\n\nthe   bug  ")).toBe("fix the bug");
  });

  it("truncates to TITLE_MAX with an ellipsis", () => {
    const long = "x".repeat(TITLE_MAX * 2);
    const title = deriveTitle(long);
    expect(title.length).toBe(TITLE_MAX);
    expect(title.endsWith("…")).toBe(true);
  });

  it("gives an empty message a neutral title", () => {
    expect(deriveTitle("   \n ")).toBe("New conversation");
  });

  it("keeps a short title intact", () => {
    expect(deriveTitle("hello")).toBe("hello");
  });

  it("never exceeds TITLE_MAX for multi-line input", () => {
    const long = Array.from({ length: 40 }, () => "word").join("\n");
    expect(deriveTitle(long).length).toBeLessThanOrEqual(TITLE_MAX);
  });
});

describe("viewFromMessages", () => {
  it("round-trips a user/assistant exchange", () => {
    const assistant = {
      kind: "assistant" as const,
      blocks: [
        { kind: "text" as const, text: "hi there" },
        {
          kind: "tool" as const,
          tool: {
            id: "t1",
            name: "Bash",
            summary: "ls",
            input: { command: "ls" },
            output: "a b",
            ok: true,
            status: "ok" as const,
            parentToolUseId: null,
          },
        },
      ],
      end: {
        reason: "done" as const,
        model: "sonnet",
        durationMs: 10,
        costUsd: 0.01,
        tokens: { input: 3, output: 4 },
        error: null,
      },
    };
    const view = viewFromMessages([
      { role: "user", content: userMessageContent("hello") },
      { role: "assistant", content: assistantMessageContent(assistant) },
    ]);
    expect(view.running).toBe(false);
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toEqual({ kind: "user", text: "hello" });
    expect(view.turns[1]).toEqual(assistant);
  });

  it("starts empty for no rows", () => {
    expect(viewFromMessages([])).toEqual({
      turns: [],
      running: false,
      started: false,
    });
  });

  it("skips rows it cannot understand instead of throwing", () => {
    const view = viewFromMessages([
      { role: "user", content: {} }, // no text
      { role: "assistant", content: { blocks: "not-an-array" } }, // unparseable
      { role: "system", content: { text: "ignored" } }, // not a turn
      { role: "user", content: userMessageContent("kept") },
    ]);
    expect(view.turns).toEqual([{ kind: "user", text: "kept" }]);
  });

  it("drops unknown block kinds and keeps the rest", () => {
    const view = viewFromMessages([
      {
        role: "assistant",
        content: {
          blocks: [
            { kind: "mystery", payload: 1 },
            { kind: "text", text: "visible" },
          ],
        },
      },
    ]);
    expect(view.turns[0]).toEqual({
      kind: "assistant",
      blocks: [{ kind: "text", text: "visible" }],
      end: null,
    });
  });

  it("renders a replayed permission card as history, never answerable", () => {
    const view = viewFromMessages([
      {
        role: "assistant",
        content: {
          blocks: [
            {
              kind: "permission",
              card: {
                requestId: "r1",
                toolName: "Bash",
                toolUseId: "t1",
                input: { command: "rm -rf x" },
                displayHint: "Bash(rm -rf x)",
                status: "pending",
                answer: "deny",
              },
            },
          ],
        },
      },
    ]);
    const block = (view.turns[0] as { blocks: unknown[] }).blocks[0] as {
      kind: string;
      card: { status: string; answer: string | null };
    };
    expect(block.kind).toBe("permission");
    expect(block.card.status).toBe("answered");
    expect(block.card.answer).toBe("deny");
  });

  it("tolerates an invalid end reason", () => {
    const view = viewFromMessages([
      {
        role: "assistant",
        content: { blocks: [{ kind: "text", text: "x" }], end: { reason: "bogus" } },
      },
    ]);
    expect((view.turns[0] as { end: unknown }).end).toBeNull();
  });
});
