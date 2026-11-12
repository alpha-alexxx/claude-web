import type { McpServer, McpSyncOutcome } from "@/lib/mcp/types";
import { asRecord, getJson, sendJson, type ApiFailure } from "./api";

/**
 * Browser transport for the MCP page.
 *
 * Two separate writes, deliberately: `saveMcpServers` replaces the app's
 * registry, and `syncMcpToTool` pushes it into one tool's own config file.
 * Keeping them apart means a typo in the editor cannot rewrite four files at
 * once, and the page can show which tool is out of date.
 *
 * The sync request names a TOOL, never a path — the destination is a server
 * decision, so a client cannot aim a write at an arbitrary file.
 */

export type McpResult = { ok: true; servers: McpServer[] } | ApiFailure;

export type McpSaveOutcome = { ok: true; servers: McpServer[] } | ApiFailure;

export async function getMcpServers(
  opts: { fetch?: typeof fetch } = {},
): Promise<McpResult> {
  const result = await getJson("/api/mcp", opts.fetch);
  if (!result.ok) return result;

  const body = asRecord(result.body);
  if (!body || !Array.isArray(body.servers)) {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, servers: body.servers as McpServer[] };
}

export async function saveMcpServers(
  servers: McpServer[],
  opts: { fetch?: typeof fetch } = {},
): Promise<McpSaveOutcome> {
  const result = await sendJson("/api/mcp", "PUT", { servers }, opts.fetch);
  if (!result.ok) return result;

  const body = asRecord(result.body);
  return {
    ok: true,
    servers: Array.isArray(body?.servers) ? (body.servers as McpServer[]) : servers,
  };
}

export async function syncMcpToTool(
  tool: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<McpSyncOutcome> {
  const result = await sendJson("/api/mcp/sync", "POST", { tool }, opts.fetch);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const body = asRecord(result.body);
  return {
    ok: true,
    path: typeof body?.path === "string" ? body.path : undefined,
    count: typeof body?.count === "number" ? body.count : undefined,
  };
}
