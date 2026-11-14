import { describe, it, expect } from "vitest";
import { parseEnv } from "./env";

const VALID = {
  ALLOWED_WORKSPACE_ROOTS: "/home/ubuntu/projects,/home/ubuntu/claude-web",
  CLERK_SECRET_KEY: "sk_test_placeholder",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
};

describe("parseEnv", () => {
  it("accepts a minimal valid env and applies defaults", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_PATH).toBe("./data/claude-web.db");
    expect(env.HOST).toBe("localhost");
    expect(env.PORT).toBe(8765);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.ENABLED_PROVIDERS).toEqual(["claude"]);
    expect(env.MAX_CONCURRENT_TURNS).toBe(2);
    expect(env.TURN_TIMEOUT_MS).toBe(1_800_000);
  });

  it("splits ALLOWED_WORKSPACE_ROOTS into a list, trimming whitespace", () => {
    const env = parseEnv({
      ...VALID,
      ALLOWED_WORKSPACE_ROOTS: " /a , /b ,/c",
    });
    expect(env.ALLOWED_WORKSPACE_ROOTS).toEqual(["/a", "/b", "/c"]);
  });

  it("refuses when CLERK_SECRET_KEY is missing", () => {
    const { CLERK_SECRET_KEY: _drop, ...rest } = VALID;
    expect(() => parseEnv(rest)).toThrow(/CLERK_SECRET_KEY/);
  });

  it("refuses when the Clerk publishable key is missing", () => {
    const { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: _drop, ...rest } = VALID;
    expect(() => parseEnv(rest)).toThrow(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  });

  it("refuses a secret key pasted into the public variable", () => {
    expect(() =>
      parseEnv({ ...VALID, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_test_leak" }),
    ).toThrow(/must start with pk_/);
  });

  it("refuses a publishable key pasted into the secret variable", () => {
    expect(() => parseEnv({ ...VALID, CLERK_SECRET_KEY: "pk_test_leak" })).toThrow(
      /must start with sk_/,
    );
  });

  it("coerces TRUST_PROXY from string", () => {
    expect(parseEnv({ ...VALID, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ ...VALID, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(true);
    expect(parseEnv({ ...VALID, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
  });

  it("parses PORT and bounded numeric settings", () => {
    const env = parseEnv({ ...VALID, PORT: "9000", MAX_CONCURRENT_TURNS: "4" });
    expect(env.PORT).toBe(9000);
    expect(env.MAX_CONCURRENT_TURNS).toBe(4);
    expect(() => parseEnv({ ...VALID, PORT: "not-a-port" })).toThrow();
    expect(() =>
      parseEnv({ ...VALID, MAX_CONCURRENT_TURNS: "0" }),
    ).toThrow();
    expect(() => parseEnv({ ...VALID, MAX_CONCURRENT_TURNS: "99" })).toThrow();
  });

  it("splits ENABLED_PROVIDERS and restricts to known providers", () => {
    expect(
      parseEnv({ ...VALID, ENABLED_PROVIDERS: "claude,codex" })
        .ENABLED_PROVIDERS,
    ).toEqual(["claude", "codex"]);
    expect(() =>
      parseEnv({ ...VALID, ENABLED_PROVIDERS: "claude,gopher" }),
    ).toThrow();
  });

  it("CLAUDE_EXECUTABLE is optional and passes through", () => {
    expect(parseEnv(VALID).CLAUDE_EXECUTABLE).toBeUndefined();
    expect(
      parseEnv({ ...VALID, CLAUDE_EXECUTABLE: "/usr/local/bin/claude" })
        .CLAUDE_EXECUTABLE,
    ).toBe("/usr/local/bin/claude");
  });

  it("INSTALL_ALLOWLIST parses into a package list; empty means disabled", () => {
    expect(parseEnv(VALID).INSTALL_ALLOWLIST).toEqual([]);
    expect(
      parseEnv({ ...VALID, INSTALL_ALLOWLIST: "@openai/codex@0.167.0" })
        .INSTALL_ALLOWLIST,
    ).toEqual(["@openai/codex@0.167.0"]);
  });

  it("ALLOWED_DEV_ORIGINS parses into a trimmed hostname list and defaults to empty", () => {
    expect(parseEnv(VALID).ALLOWED_DEV_ORIGINS).toEqual([]);
    expect(
      parseEnv({ ...VALID, ALLOWED_DEV_ORIGINS: " dev.example.com , a.b.org " })
        .ALLOWED_DEV_ORIGINS,
    ).toEqual(["dev.example.com", "a.b.org"]);
  });
});
