import "server-only";
import type { ProviderId } from "@/lib/providers/types";
import type { AuthMethod } from "./types";

/** Re-exported: auth kind is part of both the server and client shape. */
export type { AuthMethod };

/**
 * The provider integration registry — everything the Integrations page needs
 * to know about a CLI that is NOT its adapter: how to find it, how to install
 * it, how big it is, and where its credentials live.
 *
 * Versions are pinned EXACTLY. An install button is only ever wired to a spec
 * declared here, and the spec must also appear verbatim in
 * INSTALL_ALLOWLIST before the server will run it. Two independent gates
 * because either one alone is a single typo away from installing something
 * else.
 *
 * Claude is deliberately first-class-exempt: the Agent SDK bundles its own CLI
 * binary, so there is nothing to detect on PATH, nothing to install, and no
 * credential handling at all (the host's own login is inherited).
 */

export interface IntegrationSpec {
  id: ProviderId;
  /** Display name, matched to the adapter's own naming. */
  label: string;
  /** One sentence, user-facing — what this CLI is for. */
  description: string;
  /** Executable name resolved on PATH. Null = no external binary. */
  bin: string | null;
  /** Arguments that make the binary print its version. */
  versionArgs: string[];
  /** npm package spec, pinned to an exact version — null = not installable. */
  installSpec: string | null;
  /** Approximate unpacked size, for the disk preflight. */
  diskBytes: number;
  authMethod: AuthMethod;
  /** Env var names this provider accepts as credentials. */
  credentialKeys: string[];
  /**
   * How the keys combine: `"any"` (default) = alternatives, one is enough;
   * `"all"` = every key is required. Each provider here declares alternatives
   * — an API key or a device login — so "any" is the honest reading, and
   * treating a lone key as incomplete would refuse a working setup.
   */
  credentialMode?: "any" | "all";
  /** Documentation link shown in the UI. */
  docsUrl: string;
}

export const INTEGRATIONS: readonly IntegrationSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    description:
      "Anthropic's coding agent. Bundled with the app — it uses this host's Claude login.",
    bin: null,
    versionArgs: [],
    installSpec: null,
    diskBytes: 0,
    authMethod: "host-login",
    credentialKeys: [],
    docsUrl: "https://docs.claude.com/en/docs/claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    description:
      "OpenAI's coding agent. Installed globally with npm; signs in with a device code or an API key.",
    bin: "codex",
    versionArgs: ["--version"],
    installSpec: "@openai/codex@0.167.0",
    diskBytes: 437 * 1024 * 1024,
    authMethod: "device-code",
    credentialKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    docsUrl: "https://developers.openai.com/codex",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description:
      "An open-source coding agent with its own server API. Credentials come from environment variables.",
    bin: "opencode",
    versionArgs: ["--version"],
    installSpec: "@opencode/cli@2.2.6",
    diskBytes: 204 * 1024 * 1024,
    authMethod: "env-import",
    credentialKeys: ["OPENCODE_API_KEY"],
    docsUrl: "https://opencode.ai/docs",
  },
  {
    id: "qoder",
    label: "Qoder",
    description:
      "Qoder's coding agent. Authenticates with a personal access token.",
    bin: "qoder",
    versionArgs: ["--version"],
    installSpec: "@qoder-ai/qodercli@1.1.86",
    diskBytes: 64 * 1024 * 1024,
    authMethod: "token",
    credentialKeys: ["QODER_PERSONAL_ACCESS_TOKEN"],
    docsUrl: "https://docs.qoder.com",
  },
];

export function integrationSpec(id: ProviderId): IntegrationSpec | null {
  return INTEGRATIONS.find((s) => s.id === id) ?? null;
}

/** Version label from a `--version` output, or the raw first line. */
export function parseVersionOutput(output: string): string | null {
  const first = output.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  // Most CLIs print "name 1.2.3" or "1.2.3", so the FIRST version-looking token
  // on the first non-empty line is the number: a leading name is the only thing
  // that can precede it, and anything after it ("(Claude Code)") is a label.
  const match = first.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  return match ? match[0] : first.slice(0, 64);
}
