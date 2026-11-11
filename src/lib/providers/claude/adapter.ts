import "server-only";
import type {
  ActiveSession,
  ModelInfo,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderInventory,
  SessionOpts,
} from "../types";
import { getEnv } from "../../env";
import { ClaudeSessionPool, type PoolGetOpts } from "./session-pool";

/**
 * Claude adapter — the v1-complete implementation of the provider seam.
 * Everything UI-facing flows through the neutral TurnEvent contract; no
 * other module imports claude-agent-sdk.
 */

const CAPABILITIES: ProviderCapabilities = {
  interactiveToolPrompts: true,
  sessionResume: true,
  partialText: true,
  skills: "native",
  plugins: true,
};

/** Models offered in the picker (DEFAULT_MODEL=auto maps to no override). */
const DEFAULT_MODELS: ModelInfo[] = [
  { id: "sonnet", label: "Claude Sonnet (balanced)" },
  { id: "opus", label: "Claude Opus (most capable)" },
  { id: "haiku", label: "Claude Haiku (fastest)" },
  { id: "auto", label: "Auto (CLI default)" },
];

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly capabilities = CAPABILITIES;
  private readonly pool: ClaudeSessionPool;

  constructor(pool?: ClaudeSessionPool) {
    // Cap from env (MAX_CONCURRENT_TURNS). The pool never respawns per turn,
    // so each live conversation holds one ~1 GiB CLI process.
    this.pool = pool ?? new ClaudeSessionPool(undefined, getEnv().MAX_CONCURRENT_TURNS);
  }

  async inventory(): Promise<ProviderInventory> {
    // The SDK bundles its own CLI binary — nothing to detect at startup.
    // Credential source is read from the first live session's init frame
    // (apiKeySource), surfaces in the health check.
    return {
      id: this.id,
      installed: true,
      version: null, // resolved lazily from a live session (claude_code_version)
      authed: null, // no probe cheaper than starting a session — see health check
      reason: null,
      models: DEFAULT_MODELS,
    };
  }

  async startsSession(opts: SessionOpts): Promise<ActiveSession> {
    const getOpts: PoolGetOpts = {
      cwd: opts.cwd,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId ?? null,
      onPermission: opts.onPermission,
    };
    const session = this.pool.get(opts.conversationId, getOpts);
    return {
      send: (text) => session.send(text),
      interrupt: () => session.interrupt(),
      onEvent: (cb) => session.onEvent(cb),
      offEvent: (cb) => session.offEvent(cb),
      close: () => session.close(),
    };
  }

  /** Live pool session handle — used by the health check and resume logic. */
  poolSession(conversationId: string) {
    return this.pool.getIfLive(conversationId);
  }

  size(): number {
    return this.pool.size();
  }

  async closeAll(): Promise<void> {
    await this.pool.closeAll();
  }
}

/**
 * Per-server singleton adapter. Node module graph is shared across route
 * handlers in dev and prod, so one pool instance is shared per process.
 */
let singleton: ClaudeAdapter | null = null;

export function getClaudeAdapter(): ClaudeAdapter {
  if (!singleton) singleton = new ClaudeAdapter();
  return singleton;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function resetClaudeAdapterForTest(): void {
  singleton = null;
}
