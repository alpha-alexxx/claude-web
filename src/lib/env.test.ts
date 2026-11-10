import { describe, it, expect } from "vitest";
import { parseEnv } from "./env";

const VALID = {
  SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef", // 48 chars
  ALLOWED_WORKSPACE_ROOTS: "/home/ubuntu/projects,/home/ubuntu/claude-web",
};

describe("parseEnv", () => {
  it("accepts a minimal valid env and applies defaults", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_PATH).toBe("./data/claude-web.db");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(8765);
    expect(env.COOKIE_SECURE).toBe("auto");
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

  it("refuses a SESSION_SECRET shorter than 32 bytes", () => {
    expect(() =>
      parseEnv({ ...VALID, SESSION_SECRET: "too-short" }),
    ).toThrow(/SESSION_SECRET.*32/);
  });

  it("refuses when SESSION_SECRET is missing", () => {
    const { SESSION_SECRET: _drop, ...rest } = VALID;
    expect(() => parseEnv(rest)).toThrow(/SESSION_SECRET/);
  });

  it("rejects COOKIE_SECURE values outside auto|true|false", () => {
    expect(() => parseEnv({ ...VALID, COOKIE_SECURE: "maybe" })).toThrow();
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
});
