import { ToolSettingsPage } from "@/components/settings/tool-settings-surface";

/** /settings/codex — `~/.codex/config.toml`, redacted, edited as TOML. */
export default function CodexSettingsPage() {
  return <ToolSettingsPage tool="codex" />;
}
