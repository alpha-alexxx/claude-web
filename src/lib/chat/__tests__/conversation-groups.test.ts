import { describe, it, expect } from "vitest";
import { groupByRecency } from "../conversation-groups";

/**
 * Sidebar grouping.
 *
 * Recency is the list's own ordering, so date buckets encode real structure
 * (what the user will scroll past) rather than decoration. Buckets are
 * LOCAL-calendar based: "Today" must mean the user's today, not UTC's.
 */

function at(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

const NOW = new Date(2026, 0, 15, 18, 0, 0); // local 15 Jan 2026, 18:00

function conv(id: string, updatedAt: string) {
  return { id, updatedAt };
}

describe("groupByRecency", () => {
  it("splits into today, yesterday, previous 7 days and older", () => {
    const groups = groupByRecency(
      [
        conv("today", at(2026, 1, 15, 9)),
        conv("yesterday", at(2026, 1, 14, 23)),
        conv("week", at(2026, 1, 11, 8)),
        conv("old", at(2025, 12, 20)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["today"]],
      ["Yesterday", ["yesterday"]],
      ["Previous 7 days", ["week"]],
      ["Older", ["old"]],
    ]);
  });

  it("omits empty buckets instead of rendering headings with nothing under them", () => {
    const groups = groupByRecency([conv("today", at(2026, 1, 15, 9))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
  });

  it("keeps input order inside a bucket (the server already sorted it)", () => {
    const groups = groupByRecency(
      [conv("a", at(2026, 1, 15, 16)), conv("b", at(2026, 1, 15, 8))],
      NOW,
    );
    expect(groups[0].items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("treats a future timestamp (clock skew) as today rather than hiding it", () => {
    const groups = groupByRecency([conv("future", at(2026, 1, 16, 2))], NOW);
    expect(groups[0].label).toBe("Today");
  });

  it("treats an unparseable timestamp as older rather than throwing", () => {
    const groups = groupByRecency([{ id: "bad", updatedAt: "not a date" }], NOW);
    expect(groups.map((g) => g.label)).toEqual(["Older"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupByRecency([], NOW)).toEqual([]);
  });
});
