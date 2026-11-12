"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  getMcpServers,
  saveMcpServers,
  syncMcpToTool,
} from "@/lib/client/mcp-client";
import { MCP_TOOLS, type McpServer, type McpTarget } from "@/lib/mcp/types";
import { TOOL_LABELS } from "@/lib/tools";

/**
 * McpPanel: edit the app's one MCP registry, then push it into each tool's
 * own config file.
 *
 * The two writes stay separate on purpose, and the page shows it. "Save"
 * changes `data/mcp-servers.json` — the list this app owns. "Sync" is the
 * only thing that writes `~/.claude.json`, `~/.codex/config.toml` and the
 * rest, one tool at a time, so a half-finished edit cannot rewrite four files.
 *
 * Saving does not imply anything about the tools, and the page does not
 * pretend otherwise: after a save every tool's config is out of date until
 * you sync it, and the sync result says which file and how many servers
 * landed there — or which file it refused to touch and why.
 *
 * The editor is a draft over the saved list. Nothing is written until Save,
 * and a failed save leaves the draft intact so a validation message (which
 * names the offending row) does not cost the operator their typing.
 */

export interface McpPanelProps {
  initialServers: McpServer[];
}

interface DraftRow {
  /** Stable key for React; names can be edited, so index alone would shuffle. */
  key: string;
  name: string;
  command: string;
  /** One argument per line — a textarea is the honest shape for an argv. */
  args: string;
  /** `KEY=VALUE` per line; values are passed to the child, never to a shell. */
  env: string;
  enabled: boolean;
}

let nextKey = 0;
function draftFrom(server: McpServer): DraftRow {
  nextKey += 1;
  return {
    key: `row-${nextKey}`,
    name: server.name,
    command: server.command,
    args: server.args.join("\n"),
    env: Object.entries(server.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    enabled: server.enabled,
  };
}

function blankRow(): DraftRow {
  nextKey += 1;
  return { key: `row-${nextKey}`, name: "", command: "", args: "", env: "", enabled: true };
}

/** Textarea → argv. Blank lines are not arguments. */
function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Textarea → env record. A line without `=` is NOT silently dropped: it is
 * returned as an error so the operator sees which line the server would have
 * rejected, instead of watching it vanish on save.
 */
function parseEnv(text: string): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `"${line}" is not KEY=VALUE` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env };
}

export function McpPanel({ initialServers }: McpPanelProps) {
  const [saved, setSaved] = useState(initialServers);
  const [rows, setRows] = useState<DraftRow[]>(() => initialServers.map(draftFrom));
  const [saving, setSaving] = useState(false);
  const [syncingTool, setSyncingTool] = useState<McpTarget | null>(null);
  const [results, setResults] = useState<
    Partial<Record<McpTarget, { ok: boolean; text: string }>>
  >({});

  const dirty = useMemo(() => {
    if (rows.length !== saved.length) return true;
    return rows.some((row, i) => {
      const server = saved[i];
      return (
        row.name.trim() !== server.name ||
        row.command.trim() !== server.command ||
        row.enabled !== server.enabled ||
        parseArgs(row.args).join("\u0000") !== server.args.join("\u0000") ||
        row.env.trim() !==
          Object.entries(server.env ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
      );
    });
  }, [rows, saved]);

  const update = useCallback((key: string, patch: Partial<DraftRow>) => {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }, []);

  const save = useCallback(async () => {
    // Build the payload here so a bad env line fails before the request and
    // the message can point at the row by name.
    const servers: McpServer[] = [];
    for (const row of rows) {
      const name = row.name.trim();
      const command = row.command.trim();
      if (name === "" && command === "") continue; // a row nobody filled in
      if (name === "" || command === "") {
        toast.error("Every server needs a name and a command.");
        return;
      }
      const env = parseEnv(row.env);
      if ("error" in env) {
        toast.error(`${name || "That row"}: ${env.error}`);
        return;
      }
      servers.push({
        name,
        command,
        args: parseArgs(row.args),
        env: Object.keys(env.env).length > 0 ? env.env : undefined,
        enabled: row.enabled,
      });
    }

    setSaving(true);
    try {
      const outcome = await saveMcpServers(servers);
      if (!outcome.ok) {
        toast.error(outcome.message ?? describeSaveFailure(outcome.code));
        return;
      }
      setSaved(outcome.servers);
      setRows(outcome.servers.map(draftFrom));
      toast.success(`${outcome.servers.length} server${outcome.servers.length === 1 ? "" : "s"} saved`);
    } finally {
      setSaving(false);
    }
  }, [rows]);

  const sync = useCallback(
    async (tool: McpTarget) => {
      setSyncingTool(tool);
      try {
        const outcome = await syncMcpToTool(tool);
        if (outcome.ok) {
          const count = outcome.count ?? 0;
          setResults((current) => ({
            ...current,
            [tool]: {
              ok: true,
              text: `Wrote ${count} enabled server${count === 1 ? "" : "s"} to ${outcome.path ?? TOOL_LABELS[tool]}`,
            },
          }));
          toast.success(`${TOOL_LABELS[tool]} config updated`);
          return;
        }
        // A refusal names the file the operator has to fix by hand.
        const text = outcome.message ?? describeSyncFailure(outcome.code);
        setResults((current) => ({ ...current, [tool]: { ok: false, text } }));
        toast.error(text);
      } finally {
        setSyncingTool(null);
      }
    },
    [],
  );

  const reload = useCallback(async () => {
    const result = await getMcpServers();
    if (!result.ok) {
      toast.error("Could not reload the MCP registry.");
      return;
    }
    setSaved(result.servers);
    setRows(result.servers.map(draftFrom));
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="font-heading text-xl leading-tight">MCP servers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One list here, written into each tool&rsquo;s own config. Tools do not
          read each other&rsquo;s files, so the app generates all four.
        </p>
      </header>

      <section className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="font-heading text-sm font-medium">Registry</h2>
          {dirty && <Badge variant="outline">Unsaved changes</Badge>}
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => void reload()}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <p className="text-sm font-medium">No servers yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add one below, save it, then sync it into the tools you use. A
              disabled server is left out of every generated config.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <li key={row.key}>
                <ServerRow
                  row={row}
                  index={index}
                  onChange={(patch) => update(row.key, patch)}
                  onRemove={() =>
                    setRows((current) => current.filter((r) => r.key !== row.key))
                  }
                />
              </li>
            ))}
          </ul>
        )}

        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setRows((current) => [...current, blankRow()])}
        >
          Add server
        </Button>
      </section>

      <section>
        <h2 className="mb-1 font-heading text-sm font-medium">Sync to a tool</h2>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Only servers this list names are rewritten, so anything you added to a
          tool&rsquo;s config by hand survives. Save before syncing.
        </p>

        <ul className="flex flex-col gap-2">
          {MCP_TOOLS.map((tool) => {
            const result = results[tool.id];
            return (
              <li
                key={tool.id}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{tool.label}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {tool.file}
                  </p>
                  {result && (
                    <p
                      role="status"
                      className={
                        result.ok
                          ? "mt-1 text-xs text-success"
                          : "mt-1 text-xs text-warning"
                      }
                    >
                      {result.text}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={syncingTool !== null}
                  onClick={() => void sync(tool.id)}
                >
                  {syncingTool === tool.id ? "Syncing…" : "Sync"}
                </Button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function describeSaveFailure(code: string): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many saves in a minute. Wait a moment before trying again.";
    case "duplicate_name":
      return "Two servers share a name. Names must be unique.";
    case "invalid_body":
      return "A server is missing a name or a command.";
    case "forbidden":
      return "You need admin access to change the registry.";
    default:
      return "Could not save the registry. Try again.";
  }
}

function describeSyncFailure(code: string | undefined): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many syncs. Wait a moment before trying again.";
    case "refused":
      return "The tool's config file is not valid, so it was left untouched.";
    default:
      return "Could not write that tool's config. Try again.";
  }
}

interface ServerRowProps {
  row: DraftRow;
  index: number;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
}

function ServerRow({ row, index, onChange, onRemove }: ServerRowProps) {
  const fieldId = (suffix: string) => `mcp-${row.key}-${suffix}`;
  const label = row.name.trim() || `Server ${index + 1}`;

  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="font-heading text-sm font-medium">{label}</h3>
        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor={fieldId("enabled")} className="text-xs text-muted-foreground">
            Enabled
          </Label>
          <Switch
            id={fieldId("enabled")}
            checked={row.enabled}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
          >
            Remove
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("name")} className="text-xs">
            Name
          </Label>
          <Input
            id={fieldId("name")}
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="files"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("command")} className="text-xs">
            Command
          </Label>
          <Input
            id={fieldId("command")}
            value={row.command}
            onChange={(e) => onChange({ command: e.target.value })}
            placeholder="npx"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("args")} className="text-xs">
            Arguments — one per line
          </Label>
          <Textarea
            id={fieldId("args")}
            value={row.args}
            onChange={(e) => onChange({ args: e.target.value })}
            rows={3}
            placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/home/ubuntu"}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("env")} className="text-xs">
            Environment — KEY=VALUE per line
          </Label>
          <Textarea
            id={fieldId("env")}
            value={row.env}
            onChange={(e) => onChange({ env: e.target.value })}
            rows={3}
            placeholder="API_TOKEN=…"
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-[13px]"
          />
          <p className="text-[11px] text-muted-foreground">
            Written into the tool&rsquo;s config file in plain text. Prefer a
            value the tool can read from its own environment.
          </p>
        </div>
      </div>
    </div>
  );
}
