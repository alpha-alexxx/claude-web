import type { ProviderId } from "@/lib/providers/types";

/**
 * The Integrations page's DTOs — deliberately a plain module with no
 * `server-only` import and no database, filesystem or environment access.
 *
 * The page is a Client Component tree (it holds form state, toggles and
 * pending actions), so it must be able to name these shapes without pulling
 * the server read model into the browser bundle. `view.ts` builds them; this
 * file only describes them. Each type exists as a wire contract, which is
 * also why every field is already a rendered value (labels, formatted sizes)
 * rather than something the client would have to derive from host facts.
 */

export type AuthMethod =
  | "host-login"
  | "device-code"
  | "api-key"
  | "env-import"
  | "token";

export type DetectStatus = "installed" | "broken" | "missing" | "bundled";

export type InstallRefusal =
  | "unknown_provider"
  | "not_installable"
  | "installs_disabled"
  | "not_allowlisted"
  | "npm_not_found"
  | "insufficient_disk";

/** Credentials are reported as a shape, never as material. */
export interface CredentialStatus {
  /**
   * True when this provider has what it needs to authenticate.
   *
   * Which combination counts is declared by the registry's `credentialMode`:
   * `"any"` (the default) means the declared keys are alternatives — Codex
   * takes an API key *or* a device login, so either one is enough — while
   * `"all"` means every declared key is required. Reports only what was
   * written to the credentials file; a device login performed by the CLI
   * itself leaves nothing here and still works.
   */
  configured: boolean;
  /** Which keys are set — names only, never values. */
  presentKeys: string[];
}

export interface IntegrationView {
  id: ProviderId;
  label: string;
  description: string;
  docsUrl: string;
  authMethod: AuthMethod;
  /** Unpacked size, rendered server-side so MiB math lives in one place. */
  sizeLabel: string;
  status: DetectStatus;
  version: string | null;
  /** Version observed ≠ the registry's pin (installed, but not the audited one). */
  drift: boolean;
  /** Detection's own explanation, shown verbatim when present. */
  statusReason: string | null;
  /** Enabled in the DB (operator intent) — independent of adapter existence. */
  enabled: boolean;
  /** The adapter ships in this build. */
  adapterAvailable: boolean;
  /** enabled AND adapterAvailable — the only state in which chat offers it. */
  active: boolean;
  credentials: CredentialStatus;
  credentialKeys: string[];
  install: {
    spec: string | null;
    /** True when the allowlist + npm + disk gates all pass right now. */
    allowed: boolean;
    refusal: InstallRefusal | null;
    reason: string | null;
    /** Free space measured at npm's global prefix, for the card's caption. */
    freeLabel: string | null;
  };
}

export interface IntegrationsView {
  integrations: IntegrationView[];
  /** Server-side installs are entirely off when INSTALL_ALLOWLIST is empty. */
  installsEnabled: boolean;
  /** True when INSTALL_ALLOWLIST names something outside the registry. */
  allowlistWarning: string | null;
}
