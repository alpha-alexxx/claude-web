import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearCredentials,
  credentialEnvFor,
  credentialStatus,
  credentialsPath,
  parseEnvFile,
  serializeEnvFile,
  writeCredentials,
} from "../credentials";

/**
 * The credential store's contract is narrow on purpose: names in, names out,
 * values only ever read back into a spawn env. These tests pin the injection
 * shape (a newline must not forge a second variable) and the file's mode.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-"));
  dbPath = path.join(dir, "data", "app.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseEnvFile / serializeEnvFile", () => {
  it("round-trips quoted values, export prefixes and comments", () => {
    const text = [
      "# comment",
      "export OPENAI_API_KEY=abc",
      'QODER_PERSONAL_ACCESS_TOKEN=" tok "',
      "OPENCODE_API_KEY='single'",
      "not a var line",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      OPENAI_API_KEY: "abc",
      QODER_PERSONAL_ACCESS_TOKEN: " tok ",
      OPENCODE_API_KEY: "single",
    });
    expect(serializeEnvFile({ B: "2", A: "1" })).toBe("A=1\nB=2\n");
  });
});

describe("writeCredentials", () => {
  it("creates a 0600 file inside a 0700 dir and reports configured by NAME only", () => {
    expect(writeCredentials(dbPath, "codex", { OPENAI_API_KEY: "sk-live-123" })).toEqual({
      ok: true,
    });
    const file = credentialsPath(dbPath);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    const status = credentialStatus(dbPath, "codex");
    expect(status).toEqual({ configured: true, presentKeys: ["OPENAI_API_KEY"] });
    // The only API-facing shape is names; the value must not leak through it.
    expect(JSON.stringify(status)).not.toContain("sk-live-123");
  });

  it("reports a provider with alternative keys as configured when one is set", () => {
    // Codex declares OPENAI_API_KEY and CODEX_API_KEY as alternatives. Reading
    // "configured" as "every declared key present" would refuse to enable a
    // provider the operator had just set up correctly, with a message naming a
    // key they do not have.
    writeCredentials(dbPath, "codex", { CODEX_API_KEY: "only-this-one" });
    expect(credentialStatus(dbPath, "codex")).toEqual({
      configured: true,
      presentKeys: ["CODEX_API_KEY"],
    });
  });

  it("treats an empty value as absent rather than configured", () => {
    writeCredentials(dbPath, "qoder", { QODER_PERSONAL_ACCESS_TOKEN: "   " });
    expect(credentialStatus(dbPath, "qoder").configured).toBe(false);
  });

  it("rejects a key the provider does not declare", () => {    expect(writeCredentials(dbPath, "codex", { ANTHROPIC_API_KEY: "x" })).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("rejects a newline, which would forge a second variable", () => {
    expect(
      writeCredentials(dbPath, "codex", {
        OPENAI_API_KEY: "good\nOPENCODE_API_KEY=stolen",
      }),
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("rejects empty values and non-strings", () => {
    expect(writeCredentials(dbPath, "qoder", { QODER_PERSONAL_ACCESS_TOKEN: "  " })).toEqual(
      { ok: false, error: "invalid" },
    );
    expect(
      writeCredentials(dbPath, "qoder", { QODER_PERSONAL_ACCESS_TOKEN: 42 }),
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses a provider that has no credential entry (Claude uses host login)", () => {
    expect(writeCredentials(dbPath, "claude", {})).toEqual({
      ok: false,
      error: "no_credentials",
    });
    expect(writeCredentials(dbPath, "nope" as never, { X: "y" })).toEqual({
      ok: false,
      error: "unknown_provider",
    });
  });

  it("merges providers and clears only the named provider's keys", () => {
    writeCredentials(dbPath, "codex", { OPENAI_API_KEY: "a" });
    writeCredentials(dbPath, "qoder", { QODER_PERSONAL_ACCESS_TOKEN: "b" });
    clearCredentials(dbPath, "codex");
    expect(credentialStatus(dbPath, "codex").configured).toBe(false);
    expect(credentialStatus(dbPath, "qoder").configured).toBe(true);
    expect(credentialEnvFor(dbPath, "qoder")).toEqual({
      QODER_PERSONAL_ACCESS_TOKEN: "b",
    });
  });

  it("hands back only that provider's keys for the spawn env", () => {
    writeCredentials(dbPath, "codex", { CODEX_API_KEY: "c" });
    writeCredentials(dbPath, "opencode", { OPENCODE_API_KEY: "o" });
    expect(credentialEnvFor(dbPath, "codex")).toEqual({ CODEX_API_KEY: "c" });
    expect(credentialEnvFor(dbPath, "claude")).toEqual({});
  });
});
