import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isSecretKey,
  mergeRedacted,
  redactValue,
  validateSettingsText,
} from "../redact";
import { parse as parseToml } from "smol-toml";

/**
 * Settings files are shared with the tools and hold API keys. Two rules drive
 * everything here:
 *
 *   1. A secret NEVER leaves the server. The GET path redacts by key name, at
 *      any depth, without losing the key itself — the editor must still show
 *      that `OPENAI_API_KEY` exists, just not its value.
 *   2. A redacted value round-trips. If the browser posts back the marker, the
 *      stored value is preserved rather than literally overwritten with "***".
 *      Without that, every save would silently destroy the operator's keys.
 */

describe("isSecretKey", () => {
  it("matches the names tools actually use", () => {
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "apiKey",
      "api_key",
      "token",
      "accessToken",
      "secret",
      "clientSecret",
      "password",
      "authToken",
      "QODER_PERSONAL_ACCESS_TOKEN",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does not match ordinary settings", () => {
    for (const key of ["model", "theme", "mcpServers", "sandbox", "approval_policy", "args"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it("matches the names tools actually use in every casing and separator", () => {
    // A missed name leaks a live credential out of the GET, so the detector
    // has to be broad rather than tidy: camelCase, snake, kebab and header
    // forms all reach these files in the wild.
    for (const key of [
      "bearerToken",
      "secretKey",
      "x-api-key",
      "X-Api-Key",
      "tokenValue",
      "apiKeys",
      "tokens",
      "myKey",
      "clientsecret",
      "OPENAI_BEARER",
      "authorization",
      "COOKIE",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does not match words that merely contain a secret word", () => {
    // Broadness must not reach `keyboard`/`monkey`/`author`: redacting those
    // hides operator settings and, worse, hides them from the editor for no
    // security gain.
    for (const key of ["keyboard", "keybindings", "monkey", "author", "pathway"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("redactValue", () => {
  it("redacts secret values at any depth and keeps structure", () => {
    const input = {
      model: "opus",
      env: { ANTHROPIC_API_KEY: "sk-live-123", LOG_LEVEL: "info" },
      nested: [{ token: "abc", name: "x" }],
    };
    expect(redactValue(input)).toEqual({
      model: "opus",
      env: { ANTHROPIC_API_KEY: REDACTED, LOG_LEVEL: "info" },
      nested: [{ token: REDACTED, name: "x" }],
    });
  });

  it("does not mutate its input", () => {
    const input = { env: { API_KEY: "sk-x" } };
    redactValue(input);
    expect(input.env.API_KEY).toBe("sk-x");
  });

  it("redacts secrets nested inside arrays of strings' parents", () => {
    const input = { mcpServers: { s: { env: { GITHUB_TOKEN: "ghp_x" } } } };
    expect(redactValue(input)).toEqual({
      mcpServers: { s: { env: { GITHUB_TOKEN: REDACTED } } },
    });
  });

  it("leaves non-objects alone", () => {
    expect(redactValue("plain")).toBe("plain");
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
  });

  it("redacts a whole container under a secret-named key, not just its leaves", () => {
    // `{ secrets: ["abc", "def"] }` and `{ credentials: { user, pass } }` are
    // the shapes people write in settings files. These used to be *walked*
    // and only leaf names re-tested, so `abc`/`def` came back in the clear.
    expect(redactValue({ secrets: ["abc", "def"] })).toEqual({ secrets: REDACTED });
    expect(redactValue({ credentials: { user: "u", pass: "p" } })).toEqual({
      credentials: REDACTED,
    });
  });

  it("keeps null and empty-string secret slots visible as absent", () => {
    // An empty string is how a settings editor shows "no value set"; the
    // marker would claim a secret exists.
    expect(redactValue({ API_KEY: "" })).toEqual({ API_KEY: "" });
    expect(redactValue({ API_KEY: null })).toEqual({ API_KEY: null });
  });
});

describe("mergeRedacted", () => {
  it("keeps the stored secret when the editor posts the marker back", () => {
    const stored = { env: { API_KEY: "sk-live", MODEL: "a" } };
    const submitted = { env: { API_KEY: REDACTED, MODEL: "b" } };
    expect(mergeRedacted(stored, submitted)).toEqual({
      env: { API_KEY: "sk-live", MODEL: "b" },
    });
  });

  it("accepts a genuinely new secret", () => {
    const stored = { env: { API_KEY: "sk-live" } };
    const submitted = { env: { API_KEY: "sk-new" } };
    expect(mergeRedacted(stored, submitted)).toEqual({
      env: { API_KEY: "sk-new" },
    });
  });

  it("does not resurrect a key the operator deleted", () => {
    const stored = { env: { API_KEY: "sk-live" } };
    expect(mergeRedacted(stored, { env: {} })).toEqual({ env: {} });
  });

  it("adds keys that were not there before", () => {
    expect(mergeRedacted({}, { env: { NEW_KEY: "v" } })).toEqual({
      env: { NEW_KEY: "v" },
    });
  });

  it("merges arrays by replacement, not by index", () => {
    const stored = { args: ["--a", "--secret", "sk-live"] };
    const submitted = { args: ["--b"] };
    expect(mergeRedacted(stored, { args: ["--b"] })).toEqual({ args: ["--b"] });
  });

  it("restores markers inside an array of objects, element by element", () => {
    // The destructive case: MCP server lists nest env blocks in an array. With
    // no stored element to restore from, every marker collapsed to `{}` and a
    // routine open-and-save deleted both live keys.
    const stored = {
      servers: [{ env: { API_KEY: "sk-live-1" } }, { env: { API_KEY: "sk-live-2" } }],
    };
    const submitted = {
      servers: [{ env: { API_KEY: REDACTED } }, { env: { API_KEY: REDACTED } }],
    };
    expect(mergeRedacted(stored, submitted)).toEqual({
      servers: [{ env: { API_KEY: "sk-live-1" } }, { env: { API_KEY: "sk-live-2" } }],
    });
  });

  it("keeps submitted elements when the arrays differ in length", () => {
    // Positional merging is only sound when the shapes line up; an added or
    // removed element means the editor restructured the list, and guessing
    // which stored element it matches would resurrect the wrong secret. The
    // markers in the new elements have nothing to restore from, so they drop
    // (writing a literal "***" as a credential is the destructive case).
    const stored = { servers: [{ token: "old" }] };
    const submitted = { servers: [{ token: "new" }, { token: REDACTED }] };
    expect(mergeRedacted(stored, submitted)).toEqual({
      servers: [{ token: "new" }, {}],
    });
  });

  it("handles a non-object stored side", () => {
    expect(mergeRedacted(null, { a: REDACTED })).toEqual({ a: REDACTED });
  });
});

describe("validateSettingsText", () => {
  it("accepts JSON for a json tool", () => {
    const result = validateSettingsText("json", '{"model":"opus"}');
    expect(result.ok).toBe(true);
  });

  it("rejects malformed JSON with a message the editor can show", () => {
    const result = validateSettingsText("json", '{"model":');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JSON/i);
  });

  it("rejects a JSON array at the top level", () => {
    const result = validateSettingsText("json", "[1,2]");
    expect(result.ok).toBe(false);
  });

  it("never echoes input bytes in a JSON parse error", () => {
    // V8 quotes the offending input for "Unexpected token" errors. A dropped
    // quote around a key value is a plausible hand-edit, and this message goes
    // straight into the GET response — the parse is what redacts, so echoing
    // it hands the browser exactly the secret the redaction removed.
    const result = validateSettingsText(
      "json",
      '{"env":{"OPENAI_API_KEY":sk-proj-abc123}}',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("sk-proj-abc123");
      expect(result.message).not.toContain("sk-proj-ab");
    }
  });

  it("never echoes input bytes in a TOML parse error", () => {
    const result = validateSettingsText(
      "toml",
      '[a]\napi_key = "sk-proj-abc123\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("sk-proj-abc123");
  });

  it("still says where the JSON error is, so the editor can point at it", () => {
    const result = validateSettingsText("json", '{"a":1,}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/position|line|JSON/i);
  });

  it("accepts valid TOML", () => {
    expect(validateSettingsText("toml", 'model = "gpt-5"\n').ok).toBe(true);
  });

  it("rejects malformed TOML", () => {
    const result = validateSettingsText("toml", "this is [not toml");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/TOML/i);
  });

  it("accepts empty text as an empty document", () => {
    expect(validateSettingsText("json", "  ").ok).toBe(true);
    expect(validateSettingsText("toml", "\n").ok).toBe(true);
  });

  it("parses TOML into the object the redactor will see", () => {
    const result = validateSettingsText("toml", '[mcp_servers.a]\ncommand = "x"\n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(parseToml('[mcp_servers.a]\ncommand = "x"\n')).toEqual(result.value);
    }
  });
});
