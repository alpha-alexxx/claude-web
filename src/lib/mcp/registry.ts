import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";

/**
 * One app-owned MCP registry, four incompatible native config shapes.
 *
 * Every tool reads a DIFFERENT file in a DIFFERENT shape, and none of them
 * reads another's config — so the only mechanism that works is generating each
 * tool's native file from a single source. This module is that generator and
 * nothing else: it is pure, it decides no gates, and it never touches disk. The
 * route layer owns reading/writing; keeping generation pure is what makes the
 * per-tool shapes testable against real parsers instead of snapshots.
 *
 * Disabled servers are ABSENT from the generated config, not commented out: a
 * config file is machine input, and a disabled server that lingers as a comment
 * re-enables the moment someone rewrites the file.
 *
 * Merging preserves everything the app does not own. These files are shared
 * with the tool and edited by hand, so a generator that rewrote the whole file
 * would silently delete settings this app has no model of.
 */

export type McpTarget = "claude" | "codex" | "opencode" | "qoder";

/**
 * Validation for a server as POSTed by the browser. The name is restricted to
 * a key-safe charset because it becomes a TOML table name and a JSON key; args
 * are `string[]` and only ever passed to `spawn` as an argv array, never to a
 * shell, so no value in here is interpolated into a command line.
 */
export const mcpServerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, dot, dash or underscore"),
  command: z.string().trim().min(1).max(512),
  args: z.array(z.string().max(2048)).max(64).default([]),
  env: z.record(z.string().max(128), z.string().max(4096)).optional(),
  enabled: z.boolean().default(true),
});

export type McpServer = z.infer<typeof mcpServerSchema>;

/** A JSON-shaped config file — the shape three of the four tools use. */
export type JsonConfig = Record<string, unknown>;

/** Which JSON key each tool nests servers under. Codex is TOML, handled apart. */
const JSON_SECTION: Record<Exclude<McpTarget, "codex">, string> = {
  claude: "mcpServers",
  opencode: "mcp",
  qoder: "mcpServers",
};

/** The TOML root table Codex reads servers from. */
const CODEX_SECTION = "mcp_servers";

/**
 * Generate one tool's config from the registry. Returns an object for the JSON
 * tools and a TOML string for Codex — the return type is intentionally the two
 * things callers actually need, not a union the caller has to inspect.
 */
export function generateMcpConfig(
  target: "codex",
  servers: McpServer[],
): string;
export function generateMcpConfig(
  target: Exclude<McpTarget, "codex">,
  servers: McpServer[],
): JsonConfig;
export function generateMcpConfig(
  target: McpTarget,
  servers: McpServer[],
): JsonConfig | string;
export function generateMcpConfig(
  target: McpTarget,
  servers: McpServer[],
): JsonConfig | string {
  const active = servers.filter((server) => server.enabled);

  if (target === "codex") {
    // An empty registry must emit NO tables: `[mcp_servers]` alone is a table
    // the next merge would then have to distinguish from a real one.
    if (active.length === 0) return "";
    const table: Record<string, unknown> = {};
    for (const server of active) table[server.name] = genericEntry(server);
    return stringifyToml({ [CODEX_SECTION]: table });
  }

  const section: Record<string, unknown> = {};
  for (const server of active) {
    section[server.name] =
      target === "opencode" ? opencodeEntry(server) : genericEntry(server);
  }
  return { [JSON_SECTION[target]]: section };
}

/**
 * Read a JSON tool's config and return it with only the registry's servers
 * replaced. Everything else in the file — theme, permissions, other servers the
 * operator added by hand — is preserved.
 *
 * A root that is not an object (`[]`, `"text"`, `42`) is REFUSED rather than
 * treated as `{}`: replacing it would delete whatever the file actually held,
 * and the operator's next read would find their settings gone with no error
 * shown at the time they were. `null`/`undefined` mean "there is no file yet"
 * and are the normal first-sync case.
 */
export function mergeMcpConfig(
  existing: unknown,
  target: McpTarget,
  servers: McpServer[],
): JsonConfig {
  if (target === "codex") {
    throw new Error("Codex config is TOML — use mergeTomlMcp");
  }

  if (existing !== null && existing !== undefined) {
    if (typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("config root must be a JSON object");
    }
  }
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as JsonConfig) }
      : {};
  const key = JSON_SECTION[target];
  const current = base[key];
  const section =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  const generated = generateMcpConfig(target, servers)[key] as Record<
    string,
    unknown
  >;

  // Registry-managed names are authoritative — including by absence, which is
  // how a disable takes effect. Names the registry has never heard of stay.
  for (const server of servers) {
    if (server.enabled) section[server.name] = generated[server.name];
    else delete section[server.name];
  }

  base[key] = section;
  return base;
}

/**
 * Merge the registry into a Codex `config.toml` as TEXT, because Codex's file
 * also holds model, sandbox and profile settings this app does not model and
 * a parse→re-stringify round trip would reformat (and thus churn) all of it.
 *
 * The file is parsed first purely as a gate: if it does not parse we refuse,
 * because blindly appending tables to a broken file is how a half-written
 * config gets shipped. Then every `[mcp_servers.*]` table is dropped and the
 * generated ones appended, which makes the operation idempotent.
 */
export function mergeTomlMcp(existing: string, servers: McpServer[]): string {
  // Only names the registry knows are ours to rewrite; a `[mcp_servers.hand]`
  // table the operator added is preserved exactly like in the JSON path.
  const owned = new Set(servers.map((server) => server.name));

  let stripped: string;
  try {
    parseToml(existing);
    stripped = stripMcpTables(existing, owned);
  } catch {
    throw new Error("config.toml did not parse — fix it before syncing MCP servers");
  }

  const generated = generateMcpConfig("codex", servers).trimEnd();
  const head = stripped.trimEnd();

  if (generated === "") return head === "" ? "" : `${head}\n`;
  if (head === "") return `${generated}\n`;
  return `${head}\n\n${generated}\n`;
}

// -- internals ---------------------------------------------------------------

/**
 * Remove root-level `[mcp_servers.*]` tables (and any nested `[mcp_servers.a.b]`)
 * whose server name the registry owns, while leaving every other line —
 * including comments and blank lines — intact.
 */
function stripMcpTables(text: string, owned: Set<string>): string {
  const kept: string[] = [];
  let dropping = false;

  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const segments = keySegments(header[1]);
      dropping =
        segments[0] === CODEX_SECTION && segments.length > 1
          ? owned.has(segments[1])
          : false;
      if (!dropping) kept.push(line);
      continue;
    }
    if (dropping) continue;
    // `mcp_servers.foo.command = "x"` at the root is the same data in dotted
    // key form; leaving it would resurrect a server we just removed.
    const segments = dottedKeySegments(line);
    if (segments && segments[0] === CODEX_SECTION && segments.length > 2) {
      if (owned.has(segments[1])) continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}

/**
 * Split a TOML dotted key path into its segments, honouring quoted keys.
 *
 * A quoted key is a single segment no matter what it contains:
 * `mcp_servers."my.server"` is two segments, not three. Splitting on dots
 * blindly made the second segment `"my`, which no owned name can match, so the
 * generator failed to recognise its own table, kept it, and appended a
 * duplicate — a file the TOML parser then refuses to load.
 */
function keySegments(path: string): string[] {
  const segments: string[] = [];
  let index = 0;
  while (index < path.length) {
    while (index < path.length && /[\s.]/.test(path[index])) index++;
    if (index >= path.length) break;
    const quote = path[index];
    if (quote === '"' || quote === "'") {
      // Basic strings honour escapes; literal strings do not.
      let end = index + 1;
      let value = "";
      while (end < path.length && path[end] !== quote) {
        if (quote === '"' && path[end] === "\\" && end + 1 < path.length) {
          value += path[end + 1];
          end += 2;
          continue;
        }
        value += path[end];
        end += 1;
      }
      segments.push(value);
      index = end + 1;
      continue;
    }
    const bare = /^[A-Za-z0-9_-]+/.exec(path.slice(index));
    if (!bare) break;
    segments.push(bare[0]);
    index += bare[0].length;
  }
  return segments;
}

/**
 * The key path of a `key = value` line, or null when the line is not a plain
 * dotted-key assignment (a table header, a comment, or something unparseable).
 */
function dottedKeySegments(line: string): string[] | null {
  const assignment = /^\s*([^\s=]+(?:\s*\.\s*[^\s=]+)*)\s*=/.exec(line);
  if (!assignment) return null;
  return keySegments(assignment[1]);
}

/** `{ command, args, env? }` — Claude and Qoder both read this shape. */
function genericEntry(server: McpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    command: server.command,
    args: server.args,
  };
  if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
  return entry;
}

/**
 * OpenCode uses a DIFFERENT dialect: one `command` argv array (binary first)
 * and `environment` instead of `env`. Getting this wrong silently yields a
 * server that never starts, so it is spelled out rather than shared.
 */
function opencodeEntry(server: McpServer): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: "local",
    command: [server.command, ...server.args],
  };
  if (server.env && Object.keys(server.env).length > 0) {
    entry.environment = server.env;
  }
  return entry;
}
