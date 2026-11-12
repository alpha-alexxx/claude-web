import { describe, it, expect } from "vitest";
import { credentialValues, hasCredentialInput } from "./integrations-form";

/**
 * The credential form's pure half.
 *
 * Two properties are worth pinning because they are the difference between a
 * careful form and a secret-writer:
 *   - only DECLARED keys travel (an autofilled or pasted extra input is
 *     dropped here, not left to the route to reject);
 *   - empty fields are omitted, so saving one key cannot blank another.
 */

const from =
  (values: Record<string, unknown>) =>
  (key: string): unknown =>
    values[key];

const CODES = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

describe("credentialValues", () => {
  it("keeps declared keys with a value", () => {
    expect(
      credentialValues(CODES, from({ OPENAI_API_KEY: "sk-live", CODEX_API_KEY: "ck" })),
    ).toEqual({ OPENAI_API_KEY: "sk-live", CODEX_API_KEY: "ck" });
  });

  it("drops keys the provider does not declare", () => {
    expect(
      credentialValues(CODES, from({ OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "leak" })),
    ).toEqual({ OPENAI_API_KEY: "sk" });
  });

  it("omits empty, whitespace-only and non-string fields", () => {
    expect(
      credentialValues(
        CODES,
        from({ OPENAI_API_KEY: "   ", CODEX_API_KEY: "", OTHER: 42 }),
      ),
    ).toEqual({});
  });

  it("trims the edges but keeps interior characters", () => {
    expect(credentialValues(["K"], from({ K: "  a b\tc  " }))).toEqual({ K: "a b\tc" });
  });
});

describe("hasCredentialInput", () => {
  it("is false for a form nobody typed into", () => {
    expect(hasCredentialInput(CODES, from({}))).toBe(false);
    expect(hasCredentialInput(CODES, from({ OPENAI_API_KEY: "  " }))).toBe(false);
  });

  it("is true as soon as one declared field has a value", () => {
    expect(hasCredentialInput(CODES, from({ CODEX_API_KEY: "x" }))).toBe(true);
  });

  it("ignores undeclared fields", () => {
    expect(hasCredentialInput(CODES, from({ ANTHROPIC_API_KEY: "x" }))).toBe(false);
  });
});
