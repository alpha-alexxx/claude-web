"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getSkills, setSkillSync } from "@/lib/client/skills-client";
import type { SkillListItem, SkillTool, SkillsView } from "@/lib/skills/types";
import { TOOL_LABELS } from "@/lib/tools";
import { cn } from "@/lib/utils";

/**
 * SkillsPanel: the canonical `~/.agents/skills` store and its per-tool links.
 *
 * The matrix is the point of the page. Each tool relates to the store in one
 * of three ways, and the page says which rather than pretending they are the
 * same:
 *
 *   codex, opencode  read the store directly  — always synced, nothing to do
 *   claude           one directory symlink    — all skills or none
 *   qoder            a link per skill         — sync/unsync each one
 *
 * So a badge is not a checkbox: on a native tool there is no per-skill action,
 * and on Claude the whole column flips together. The buttons only appear where
 * an action can actually run, and the server still decides — a refusal (a real
 * directory in the way, a tool that reads the store natively) comes back with
 * its reason, which is what the toast shows.
 *
 * The skill body is not rendered here. It is agent input, authored on disk;
 * showing its name and description is enough to identify it, and a markdown
 * renderer on this page would be a new surface to harden for no gain.
 */

export interface SkillsPanelProps {
  initialView: SkillsView;
}

/** Which (slug, tool) pair is mid-request, so one cell's spinner is its own. */
type Pending = { slug: string; tool: SkillTool } | null;

export function SkillsPanel({ initialView }: SkillsPanelProps) {
  const [view, setView] = useState(initialView);
  const [pending, setPending] = useState<Pending>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Guards against a stale in-flight refetch replacing a newer one.
  const refreshSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const result = await getSkills();
    if (seq !== refreshSeq.current) return;
    if (result.ok) setView(result.view);
    else toast.error("Could not reload the skill store.");
  }, []);

  const checkAgain = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const run = useCallback(
    async (
      skill: SkillListItem,
      tool: SkillTool,
      action: "sync" | "unsync",
    ) => {
      setPending({ slug: skill.slug, tool });
      try {
        const outcome = await setSkillSync(skill.slug, tool, action);
        if (!outcome.ok) {
          // The refusal names the file or directory in the way — the only
          // useful thing to say, and the server is the only one who knows it.
          toast.error(
            outcome.message ??
              describeFailure(outcome.code, skill.name, tool, action),
          );
          return;
        }
        toast.success(
          action === "sync"
            ? `${skill.name} linked into ${TOOL_LABELS[tool]}`
            : `${skill.name} unlinked from ${TOOL_LABELS[tool]}`,
        );
        await reload();
      } finally {
        setPending(null);
      }
    },
    [reload],
  );

  const conflicts = view.tools.filter((tool) => tool.state === "conflict");

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0">
          <h1 className="font-heading text-xl leading-tight">Skills</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One store every tool can read. Write a skill once; link it where
            the tool needs a bridge.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={checkAgain}
          disabled={refreshing}
        >
          {refreshing ? "Checking…" : "Check again"}
        </Button>
      </header>

      <section className="mb-6 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <div className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">
              Canonical store
            </dt>
            <dd
              className="truncate font-mono text-[13px]"
              title={view.storePath}
            >
              {view.storePath}
            </dd>
          </div>
          {view.tools.map((tool) => (
            <div key={tool.tool} className="min-w-0">
              <dt className="text-[11px] text-muted-foreground">
                {TOOL_LABELS[tool.tool]}
              </dt>
              <dd className="flex items-center gap-2 text-[13px]">
                <Badge variant="outline">{MODE_LABELS[tool.mode]}</Badge>
                <ToolStateBadge state={tool.state} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {view.storeError !== null && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          The store at{" "}
          <code className="font-mono text-xs">{view.storePath}</code> could not
          be read or created, so nothing can be listed or linked. The
          filesystem said: <span className="font-mono text-xs">{view.storeError}</span>
        </p>
      )}

      {conflicts.map((tool) => (
        <p
          key={tool.tool}
          role="status"
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {TOOL_LABELS[tool.tool]} looks in{" "}
          <code className="font-mono text-xs">{tool.path}</code>, which is not
          a link to this store. It is left alone — move or remove that
          directory yourself, then check again.
        </p>
      ))}

      {view.skills.length === 0 ? (
        view.storeError === null && (
          <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <p className="text-sm font-medium">No skills yet</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Add a folder with a{" "}
              <code className="font-mono text-xs">SKILL.md</code> to the store
              above. Every tool that reads it natively picks it up immediately;
              the others need a link.
            </p>
          </div>
        )
      ) : (
        <ul className="flex flex-col gap-3">
          {view.skills.map((skill) => (
            <li key={skill.slug}>
              <SkillCard
                skill={skill}
                tools={view.tools}
                pending={pending}
                onAction={(tool, action) => void run(skill, tool, action)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MODE_LABELS: Record<"native" | "symlink" | "managed", string> = {
  native: "reads the store",
  symlink: "symlinked folder",
  managed: "managed links",
};

const STATE_LABELS: Record<"ready" | "needs_sync" | "conflict", string> = {
  ready: "Ready",
  needs_sync: "Not linked",
  conflict: "Conflict",
};

function ToolStateBadge({ state }: { state: "ready" | "needs_sync" | "conflict" }) {
  const variant =
    state === "ready" ? "secondary" : state === "conflict" ? "destructive" : "outline";
  return <Badge variant={variant}>{STATE_LABELS[state]}</Badge>;
}

function describeFailure(
  code: string,
  name: string,
  tool: SkillTool,
  action: "sync" | "unsync",
): string {
  switch (code) {
    case "network":
      return "Could not reach the server. Check your connection and try again.";
    case "rate_limited":
      return "Too many changes in a minute. Wait a moment before trying again.";
    case "invalid_slug":
      return `"${name}" is not a usable skill directory name.`;
    case "refused":
      return `The server declined to ${action} this skill for ${TOOL_LABELS[tool]}.`;
    case "forbidden":
      return "You need admin access to change the skill store.";
    default:
      return "That did not work. Try again.";
  }
}

// -- card ---------------------------------------------------------------------

interface SkillCardProps {
  skill: SkillListItem;
  tools: SkillsView["tools"];
  pending: Pending;
  onAction: (tool: SkillTool, action: "sync" | "unsync") => void;
}

function SkillCard({ skill, tools, pending, onAction }: SkillCardProps) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-sm font-medium">{skill.name}</h2>
            <code className="font-mono text-[11px] text-muted-foreground">
              {skill.slug}
            </code>
            {skill.malformed && (
              <Badge variant="destructive" title="No name in the frontmatter">
                Needs frontmatter
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {skill.description ?? "No description in the frontmatter."}
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-wrap gap-2">
        {tools.map((tool) => (
          <li key={tool.tool}>
            <SkillToolCell
              skill={skill}
              tool={tool}
              pending={pending}
              onAction={onAction}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SkillToolCellProps {
  skill: SkillListItem;
  tool: SkillsView["tools"][number];
  pending: Pending;
  onAction: (tool: SkillTool, action: "sync" | "unsync") => void;
}

/**
 * One tool's cell for one skill. What it offers depends on the tool's mode:
 *
 *   native   — nothing to do; the skill is visible by construction
 *   symlink  — the whole column moves together, so the action is the store
 *              link, and it is only offered when a skill says "missing"
 *   managed  — a real per-skill toggle
 *
 * The busy state is keyed by (slug, tool) so only the clicked cell disables —
 * unlinking one skill should not grey out the row.
 */
function SkillToolCell({ skill, tool, pending, onAction }: SkillToolCellProps) {
  const synced = skill.tools[tool.tool] === "synced";
  const busy = pending?.slug === skill.slug && pending.tool === tool.tool;
  const label = TOOL_LABELS[tool.tool];

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs",
        synced ? "border-border bg-muted/40" : "border-dashed border-border",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <Badge variant={synced ? "secondary" : "outline"}>
        {synced ? "Synced" : "Missing"}
      </Badge>

      {tool.mode === "managed" && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => onAction(tool.tool, synced ? "unsync" : "sync")}
          aria-label={
            synced
              ? `Unlink ${skill.name} from ${label}`
              : `Link ${skill.name} into ${label}`
          }
        >
          {busy ? "…" : synced ? "Unlink" : "Link"}
        </Button>
      )}

      {tool.mode === "symlink" && !synced && (
        <Button
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => onAction(tool.tool, "sync")}
          aria-label={`Link the skill store into ${label}`}
        >
          {busy ? "…" : "Link store"}
        </Button>
      )}
    </div>
  );
}
