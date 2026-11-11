"use client";

import {
  CheckmarkCircle02Icon,
  CancelCircleIcon,
  Loading03Icon,
  TerminalIcon,
  FileEditIcon,
  File01Icon,
  Search01Icon,
  GlobeIcon,
  Task01Icon,
  CheckListIcon,
  MessageQuestionIcon,
  CodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { editPreview } from "@/lib/client/diff";
import { OUTPUT_TRUNCATION_MARK } from "@/lib/providers/types";
import type { ToolCallView } from "@/lib/client/chat-view";
import { JsonDetails } from "./json-details";
import { DiffView } from "./diff-view";
import { TerminalOutput } from "./terminal-output";

/**
 * ToolCard — one tool call in the transcript. The single most repeated
 * element on the page, so its job is compression: name, the one argument
 * that identifies the target, and a status that reads without colour
 * (running / ok / failed all differ in glyph too).
 *
 * The body picks the best rendering it has: a diff for edits, terminal output
 * for Bash, raw JSON as the last resort. Rendering is chosen by tool *shape*,
 * never by provider, so a future adapter's `write_file` gets the same card.
 */

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

const TOOL_ICON: Record<string, IconData> = {
  Bash: TerminalIcon,
  BashOutput: TerminalIcon,
  KillShell: TerminalIcon,
  Read: File01Icon,
  Write: FileEditIcon,
  Edit: FileEditIcon,
  MultiEdit: FileEditIcon,
  NotebookEdit: FileEditIcon,
  Glob: Search01Icon,
  Grep: Search01Icon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Task: Task01Icon,
  TodoWrite: CheckListIcon,
  AskUserQuestion: MessageQuestionIcon,
};

function toolIcon(name: string): IconData {
  return TOOL_ICON[name] ?? CodeIcon;
}

function StatusGlyph({ status }: { status: ToolCallView["status"] }) {
  if (status === "running") {
    return (
      <HugeiconsIcon
        icon={Loading03Icon}
        className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        aria-label="Running"
      />
    );
  }
  if (status === "error") {
    return (
      <HugeiconsIcon
        icon={CancelCircleIcon}
        className="size-3.5 shrink-0 text-destructive"
        aria-label="Failed"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={CheckmarkCircle02Icon}
      className="size-3.5 shrink-0 text-success"
      aria-label="Finished"
    />
  );
}

/** Tool output is capped by the adapter; the cap is surfaced, not implied. */
function ToolBody({ tool }: { tool: ToolCallView }) {
  const preview = editPreview(tool.name, tool.input);
  const isTerminalTool = tool.name === "Bash" || tool.name === "BashOutput";
  const truncated = tool.output?.endsWith(OUTPUT_TRUNCATION_MARK) ?? false;

  return (
    <div className="space-y-1.5 border-t border-border/60 px-3 py-2">
      {preview && (
        <div className="space-y-1">
          <p className="font-mono text-[11px] break-all text-muted-foreground">
            {preview.filePath}
          </p>
          <DiffView lines={preview.lines} />
        </div>
      )}
      {!preview && tool.output !== null && (
        <TerminalOutput
          text={tool.output}
          truncated={truncated}
          label={isTerminalTool ? "Command output" : "Result"}
        />
      )}
      <JsonDetails label={preview ? "raw input" : "input"} value={tool.input} />
    </div>
  );
}

export function ToolCard({ tool }: { tool: ToolCallView }) {
  return (
    <div
      className={
        tool.status === "error"
          ? "rounded-lg border border-destructive/40"
          : "rounded-lg border border-border"
      }
    >
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <HugeiconsIcon
          icon={toolIcon(tool.name)}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span className="truncate text-muted-foreground">{tool.summary}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {tool.parentToolUseId && (
            <span
              className="rounded bg-clay-tint px-1.5 py-0.5 text-[10px] text-foreground/70"
              title="Subagent tool call (parent shown above)"
            >
              subagent
            </span>
          )}
          <StatusGlyph status={tool.status} />
        </span>
      </div>
      <ToolBody tool={tool} />
    </div>
  );
}
