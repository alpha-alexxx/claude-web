import type { SkillListItem, SkillTool, SkillSyncStatus } from "@/lib/skills/store";

/**
 * Wire contract for the Skills page. Plain module — no `server-only`, no
 * filesystem — so the Client Component tree can name these shapes without
 * pulling the store into the browser bundle.
 */

export type { SkillListItem, SkillTool, SkillSyncStatus };

export interface SkillsView {
  /** The canonical store rendered as `~/.agents/skills` for display. */
  storePath: string;
  /**
   * Why the store could not be read or created, in the filesystem's own words,
   * or null when it is usable. A missing store is not an error; a store that is
   * a file, or a home directory we cannot write to, is.
   */
  storeError: string | null;
  tools: {
    tool: SkillTool;
    mode: "native" | "symlink" | "managed";
    state: "ready" | "needs_sync" | "conflict";
    path: string;
  }[];
  skills: SkillListItem[];
}
