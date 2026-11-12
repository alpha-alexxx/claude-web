"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getSettings, saveSettings } from "@/lib/client/settings-client";
import {
  SETTINGS_TOOL_FORMATS,
  SETTINGS_TOOL_LABELS,
  type SettingsReadResult,
  type SettingsTool,
} from "@/lib/settings/types";

/**
 * ToolSettingsPanel: one tool's settings file as text, edited in place.
 *
 * Text, not a form. These files are hand-maintained, full of keys this app has
 * no business interpreting, and the tool itself is the only authority on what
 * they mean — so the editor shows the file and lets the server validate it
 * with the same parser the tool uses. Anything cleverer would be a second,
 * divergent schema.
 *
 * Two states deserve their own treatment rather than a generic error:
 *
 *   parsed: false  The server refused to echo the file. It may hold a secret
 *                  its redacting parse would have stripped, so the editor gets
 *                  empty text and a reason. The textarea is read-only here:
 *                  rendering an empty document that can be saved would offer
 *                  to replace a file we deliberately did not show.
 *
 *   backup: null   The save was a no-op. `applySettingsWrite` compares the
 *                  merged document with what is on disk and skips the write
 *                  when nothing changed, so an open-and-save does not churn
 *                  the operator's formatting or drop TOML comments. Saying
 *                  "no changes" is the honest report; a "Saved" toast would
 *                  imply a write that did not happen.
 *
 * Secrets appear as `***` and post back as `***`; the server restores the
 * stored value on save. That is why the editor never parses the text itself.
 */

export interface ToolSettingsPanelProps {
  tool: SettingsTool;
  initialSettings: SettingsReadResult;
}

export function ToolSettingsPanel({ tool, initialSettings }: ToolSettingsPanelProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [text, setText] = useState(initialSettings.text);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const label = SETTINGS_TOOL_LABELS[tool];
  const format = SETTINGS_TOOL_FORMATS[tool].toUpperCase();
  const dirty = useMemo(() => text !== settings.text, [text, settings.text]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getSettings(tool);
      if (!result.ok) {
        toast.error("Could not reload the settings file.");
        return;
      }
      setSettings(result.settings);
      setText(result.settings.text);
      setNotice(null);
    } finally {
      setRefreshing(false);
    }
  }, [tool]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const outcome = await saveSettings(tool, text);
      if (!outcome.ok) {
        // The server's message names the parse position or the file it could
        // not merge into; a generic string would lose the only useful detail.
        toast.error(outcome.message ?? describeFailure(outcome.code));
        return;
      }

      if (outcome.backup === null) {
        setNotice("No changes to write — the file on disk already matches.");
        toast.success("Nothing to save");
      } else {
        setNotice(outcome.backup ? `Saved. Previous version: ${outcome.backup}` : "Saved.");
        toast.success(`${label} settings saved`);
      }

      // Re-read rather than assume: a save may merge (restoring `***`
      // secrets), so the text on disk is not necessarily the text submitted.
      const refreshed = await getSettings(tool);
      if (refreshed.ok) {
        setSettings(refreshed.settings);
        setText(refreshed.settings.text);
      }
    } finally {
      setSaving(false);
    }
  }, [tool, text, label]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-xl leading-tight">{label} settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The file {label} reads for its own configuration. It applies to
            every conversation this app runs through {label}.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => void reload()}
          disabled={refreshing || saving}
        >
          {refreshing ? "Reloading…" : "Reload"}
        </Button>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <code
          className="truncate font-mono text-[12px] text-muted-foreground"
          title={settings.path}
        >
          {settings.path}
        </code>
        <Badge variant="outline">{format}</Badge>
        {dirty && <Badge variant="outline">Unsaved changes</Badge>}
      </div>

      {settings.exists === false && (
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          This file does not exist yet. Saving creates it.
        </p>
      )}

      {!settings.parsed && (
        <p
          role="status"
          className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {settings.message ?? "This file could not be parsed."} The contents
          are not shown, because a file that fails to parse may contain a secret
          this page cannot redact. Fix it by hand on the server, then reload.
        </p>
      )}

      <Textarea
        aria-label={`${label} settings as ${format}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        readOnly={!settings.parsed}
        rows={20}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        className="min-h-[24rem] w-full font-mono text-[13px] leading-relaxed"
      />

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Secrets are shown as <code className="font-mono">***</code> and stay as
        they are unless you type over them. Saving validates the whole document
        first, keeps a timestamped copy of the previous version, and writes
        atomically — a bad edit cannot empty the file.
      </p>

      {notice && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !settings.parsed || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {dirty && settings.parsed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setText(settings.text)}
            disabled={saving}
          >
            Discard
          </Button>
        )}
      </div>
    </div>
  );
}

function describeFailure(code: string | undefined): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many saves in a minute. Wait a moment before trying again.";
    case "invalid_settings":
      return "The file did not parse. Nothing was written.";
    case "stored_unparseable":
      return "The file on disk does not parse, so it was not replaced. Fix it on the server first.";
    case "write_failed":
      return "The file could not be written. Check permissions on the server.";
    case "forbidden":
      return "You need admin access to edit tool settings.";
    default:
      return "Could not save the settings file. Try again.";
  }
}
