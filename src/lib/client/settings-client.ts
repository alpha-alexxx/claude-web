import type {
  SettingsReadResult,
  SettingsSaveResult,
  SettingsTool,
} from "@/lib/settings/types";
import { asRecord, getJson, sendJson, type ApiFailure } from "./api";

/**
 * Browser transport for the per-tool settings editors.
 *
 * The editor sends TEXT, not a parsed object: the file's format is the tool's
 * business (JSON or TOML), and validating it in the browser would be a second
 * implementation of the parser that already exists on the server. The server
 * parses, validates, backs up and writes atomically, or refuses with a reason.
 *
 * A read can come back `parsed: false` with `text: ""` — that is the server
 * declining to echo a file it could not parse, because the file may hold a
 * secret its redacting parse would have stripped. The editor shows the parse
 * message instead of a body in that case; it must never treat the empty text
 * as "the file is empty" and offer to save it.
 */

export type SettingsReadOutcome =
  | { ok: true; settings: SettingsReadResult }
  | ApiFailure;

export async function getSettings(
  tool: SettingsTool,
  opts: { fetch?: typeof fetch } = {},
): Promise<SettingsReadOutcome> {
  const result = await getJson(`/api/settings/${encodeURIComponent(tool)}`, opts.fetch);
  if (!result.ok) return result;

  const body = asRecord(result.body);
  if (!body || typeof body.text !== "string" || typeof body.path !== "string") {
    return { ok: false, code: "invalid_response" };
  }
  return { ok: true, settings: body as unknown as SettingsReadResult };
}

export async function saveSettings(
  tool: SettingsTool,
  text: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<SettingsSaveResult> {
  const result = await sendJson(
    `/api/settings/${encodeURIComponent(tool)}`,
    "PUT",
    { text },
    opts.fetch,
  );
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const body = asRecord(result.body);
  return {
    ok: true,
    path: typeof body?.path === "string" ? body.path : undefined,
    backup: typeof body?.backup === "string" ? body.backup : null,
  };
}
