import "server-only";
import { getEnv } from "@/lib/env";
import { runArgv, type RunResult } from "@/lib/exec/run";
import { parseClaudePluginList, type PluginRecord } from "./inventory";

/**
 * Plugin inventory runner: asks each tool's own CLI what it has installed.
 *
 * Plugins are not ours to read from disk. Claude's cache directory is an
 * implementation detail that changes between releases; `claude plugin list
 * --json` is the documented interface, and it is the only source that knows
 * which plugins are ENABLED (a directory on disk says nothing about that).
 *
 * Only Claude is wired up: it is the one provider whose plugin CLI shipped a
 * machine-readable listing. The others are listed with their compat labels but
 * report no inventory, because inventing one from directory names would show
 * plugins the tool does not think it has.
 */

export type PluginRunner = (args: string[]) => Promise<RunResult>;

export interface PluginInventory {
  plugins: PluginRecord[];
  /** Why the listing is empty, when it is empty for a reason worth showing. */
  message: string | null;
}

/** The Claude executable to ask: the app's override, else the CLI on PATH. */
function claudeBin(): string {
  // `getEnv()` is the one place `CLAUDE_EXECUTABLE` is parsed and validated;
  // reading `process.env` here would bypass its trimming and its docstring.
  const override = getEnv().CLAUDE_EXECUTABLE;
  return override && override.trim() !== "" ? override : "claude";
}

/**
 * Read installed Claude plugins. Never throws: a missing binary, a non-JSON
 * output and a nonzero exit all become an empty list plus a message, because
 * the Plugins page must still render for an operator whose CLI is broken.
 */
export async function listClaudePlugins(
  runner: PluginRunner = (args) => runArgv(claudeBin(), args, { timeoutMs: 20_000 }),
): Promise<PluginInventory> {
  let result: RunResult;
  try {
    result = await runner(["plugin", "list", "--json"]);
  } catch (error) {
    return { plugins: [], message: messageOf(error) };
  }

  if (result.error) {
    return { plugins: [], message: `Could not run the Claude CLI: ${result.error}` };
  }
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || `exit code ${result.code}`;
    return { plugins: [], message: `claude plugin list failed: ${detail}` };
  }

  const plugins = parseClaudePluginList(result.stdout);
  if (plugins.length === 0 && result.stdout.trim() !== "" && result.stdout.trim() !== "[]") {
    // Parsed to nothing but the CLI said something: report rather than pretend
    // the tool has no plugins.
    return {
      plugins: [],
      message: "claude plugin list returned output this app could not read",
    };
  }
  return { plugins, message: null };
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
