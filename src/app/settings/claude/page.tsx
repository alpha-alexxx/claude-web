import { ToolSettingsPage } from "@/components/settings/tool-settings-surface";

/** /settings/claude — `~/.claude/settings.json`, redacted, edited as JSON. */
export default function ClaudeSettingsPage() {
  return <ToolSettingsPage tool="claude" />;
}
