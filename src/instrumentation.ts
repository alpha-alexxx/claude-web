/**
 * Server startup: create the canonical skills store before the first request.
 *
 * The Skills page reads `~/.agents/skills`, and Codex and OpenCode read the
 * same tree natively — for them an absent directory is an empty skills list
 * with no explanation. Creating it once at boot means the page's first render
 * shows an empty store rather than a broken one, and the `~/.claude/skills`
 * symlink is in place when Claude's first session starts, without waiting for
 * someone to open the page.
 *
 * Every failure is caught: `register` runs before the server can answer
 * anything, and a read-only home directory must not stop the app from serving
 * chat. The page re-runs `ensureSkillsStore` and reports the conflict there.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { ensureSkillsStore } = await import("@/lib/skills/store");
    const result = ensureSkillsStore();
    if (result.claude === "conflict") {
      console.warn(
        "[skills] ~/.claude/skills is a real directory, not a link to ~/.agents/skills; " +
          "Claude will not see skills authored in the canonical store until that is resolved",
      );
    }
  } catch (error) {
    console.error("[skills] could not prepare the skills store:", error);
  }
}
